import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PaymentProvider } from './payment-provider.interface.js';

const PAYMENT_PROVIDER = 'SSLCOMMERZ';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('PAYMENT_PROVIDER')
    private readonly paymentProvider: PaymentProvider,
  ) {}

  async createIntent(userId: string, orderId: string, clientKey: string) {
    const normalizedKey = clientKey?.trim();

    if (
      !normalizedKey ||
      normalizedKey.length < 8 ||
      normalizedKey.length > 255
    ) {
      throw new BadRequestException(
        'Idempotency-Key must contain 8 to 255 characters',
      );
    }

    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        userId,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Never use the raw client key as a provider key
    const idempotencyKey = createHash('sha256')
      .update(`${userId}:${orderId}:${normalizedKey}`)
      .digest('hex');

    let payment = await this.prisma.payment.findUnique({
      where: {
        provider_idempotencyKey: {
          provider: PAYMENT_PROVIDER,
          idempotencyKey,
        },
      },
    });

    if (payment) {
      // Reuse the existing checkout while still processing
      if (
        payment.status === 'PROCESSING' &&
        payment.checkoutUrl &&
        payment.providerSessionKey
      ) {
        return this.toResponse(payment);
      }

      // Terminal payments never get a new checkout
      if (payment.status !== 'PROCESSING') {
        return this.toResponse(payment);
      }
    } else {
      if (order.status !== 'PENDING_PAYMENT') {
        throw new ConflictException('Order is not awaiting payment');
      }

      try {
        payment = await this.prisma.payment.create({
          data: {
            orderId: order.id,
            provider: PAYMENT_PROVIDER,
            idempotencyKey,
            amount: order.totalAmount,
            currency: order.currency,
            status: 'PROCESSING',
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          payment = await this.prisma.payment.findUnique({
            where: {
              provider_idempotencyKey: {
                provider: PAYMENT_PROVIDER,
                idempotencyKey,
              },
            },
          });

          if (!payment) {
            throw new ConflictException(
              'Payment creation conflict; please retry',
            );
          }
        } else {
          throw error;
        }
      }
    }

    // Recheck order state; provider call runs outside a transaction
    const currentOrder = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        userId,
      },
      select: {
        status: true,
      },
    });

    if (!currentOrder || currentOrder.status !== 'PENDING_PAYMENT') {
      throw new ConflictException('Order is no longer awaiting payment');
    }

    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        email: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    let intent: Awaited<ReturnType<PaymentProvider['createIntent']>>;

    try {
      intent = await this.paymentProvider.createIntent({
        paymentId: payment.id,
        amount: payment.amount.toFixed(2),
        currency: payment.currency,
        idempotencyKey: payment.idempotencyKey,
        customerEmail: user.email,
      });
    } catch (error) {
      // Payment record is kept so a retry can reuse it
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw error;
    }

    const updatedPayment = await this.prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        providerReference: intent.providerReference,
        checkoutUrl: intent.checkoutUrl,
        providerSessionKey: intent.sessionKey,
      },
    });

    return this.toResponse(updatedPayment);
  }

  async confirmPayment(input: {
    tranId: string;
    valId: string;
    payload: Record<string, unknown>;
  }) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        provider: 'SSLCOMMERZ',
        providerReference: input.tranId,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    // Never trust the IPN status alone.
    const validated = await this.paymentProvider.validateTransaction(
      input.valId,
    );

    if (
      !['VALID', 'VALIDATED'].includes(validated.status) ||
      validated.tran_id !== payment.providerReference ||
      validated.val_id !== input.valId
    ) {
      throw new ConflictException('Payment transaction could not be verified');
    }

    const validatedAmount = new Prisma.Decimal(validated.amount);

    if (!validatedAmount.equals(payment.amount)) {
      throw new ConflictException('Payment amount mismatch');
    }

    const validatedCurrency = validated.currency_type ?? validated.currency;

    if (validatedCurrency !== payment.currency) {
      throw new ConflictException('Payment currency mismatch');
    }

    // Stable identity for retries of the same IPN.
    const providerEventId = `${input.tranId}:${input.valId}`;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Unique(provider, providerEventId) protects against concurrent and repeated delivery of the same event.
          const event = await tx.paymentEvent.create({
            data: {
              provider: 'SSLCOMMERZ',
              providerEventId,
              paymentId: payment.id,
              eventType: 'PAYMENT_VALIDATED',
              status: 'RECEIVED',
              payload: input.payload as Prisma.InputJsonValue,
            },
          });

          const currentPayment = await tx.payment.findUnique({
            where: { id: payment.id },
          });

          if (!currentPayment) {
            throw new NotFoundException('Payment not found');
          }

          // A previously successful payment must never decrement inventory a second time.
          if (currentPayment.status === 'SUCCEEDED') {
            await tx.paymentEvent.update({
              where: { id: event.id },
              data: {
                status: 'PROCESSED',
                processedAt: new Date(),
              },
            });

            return {
              received: true,
              alreadySucceeded: true,
            };
          }

          if (!['PROCESSING', 'PENDING'].includes(currentPayment.status)) {
            throw new ConflictException(
              'Payment is not in a confirmable state',
            );
          }

          // Only confirm an order that is still awaiting payment.
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: currentPayment.orderId,
              status: 'PENDING_PAYMENT',
            },
            data: {
              status: 'CONFIRMED',
            },
          });

          if (orderUpdate.count !== 1) {
            throw new ConflictException('Order is not awaiting payment');
          }

          // Fetch active reservations belonging to this order.
          const reservations = await tx.inventoryReservation.findMany({
            where: {
              orderId: currentPayment.orderId,
              status: 'ACTIVE',
            },
          });

          if (reservations.length === 0) {
            throw new ConflictException(
              'No active inventory reservations found',
            );
          }

          // Commit each reservation atomically. availableQuantity was already decremented during checkout.
          for (const reservation of reservations) {
            const inventoryUpdate = await tx.inventory.updateMany({
              where: {
                productId: reservation.productId,
                reservedQuantity: {
                  gte: reservation.quantity,
                },
              },
              data: {
                reservedQuantity: {
                  decrement: reservation.quantity,
                },
              },
            });

            if (inventoryUpdate.count !== 1) {
              throw new ConflictException(
                'Inventory reservation could not be committed',
              );
            }

            const reservationUpdate = await tx.inventoryReservation.updateMany({
              where: {
                id: reservation.id,
                status: 'ACTIVE',
              },
              data: {
                status: 'COMMITTED',
              },
            });

            if (reservationUpdate.count !== 1) {
              throw new ConflictException(
                'Inventory reservation state changed unexpectedly',
              );
            }
          }

          // Mark the payment successful only within the same transaction.
          const paymentUpdate = await tx.payment.updateMany({
            where: {
              id: currentPayment.id,
              status: {
                in: ['PROCESSING', 'PENDING'],
              },
            },
            data: {
              status: 'SUCCEEDED',
            },
          });

          if (paymentUpdate.count !== 1) {
            throw new ConflictException('Payment state changed unexpectedly');
          }

          await tx.paymentEvent.update({
            where: { id: event.id },
            data: {
              status: 'PROCESSED',
              processedAt: new Date(),
            },
          });

          return {
            received: true,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            paymentStatus: 'SUCCEEDED',
            orderStatus: 'CONFIRMED',
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      // If the unique event already exists, this delivery is a duplicate.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existingEvent = await this.prisma.paymentEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: 'SSLCOMMERZ',
              providerEventId,
            },
          },
        });

        if (existingEvent?.status === 'PROCESSED') {
          return {
            received: true,
            duplicate: true,
          };
        }
      }

      throw error;
    }
  }

  private toResponse(payment: {
    id: string;
    status: string;
    providerReference: string | null;
    checkoutUrl: string | null;
  }) {
    return {
      paymentId: payment.id,
      status: payment.status,
      providerReference: payment.providerReference,
      checkoutUrl: payment.checkoutUrl,
    };
  }
}
