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

  async handleFailureNotification(input: {
    tranId: string;
    ipnStatus: string;
    payload: Record<string, unknown>;
  }) {
    const allowedStatuses = ['FAILED', 'CANCELLED', 'EXPIRED', 'UNATTEMPTED'];

    if (!allowedStatuses.includes(input.ipnStatus)) {
      throw new BadRequestException('Unsupported non-success payment status');
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        provider: 'SSLCOMMERZ',
        providerReference: input.tranId,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status === 'SUCCEEDED') {
      return {
        received: true,
        alreadySucceeded: true,
      };
    }

    // IPN is a notification, not the source of truth.
    const transaction = await this.paymentProvider.queryTransaction(
      input.tranId,
    );

    if (transaction.tran_id !== payment.providerReference) {
      throw new ConflictException('Provider transaction ID mismatch');
    }

    // The provider may have completed payment despite a stale
    // or out-of-order failure/cancel notification.
    if (['VALID', 'VALIDATED'].includes(transaction.status)) {
      if (!transaction.val_id) {
        throw new ServiceUnavailableException(
          'Successful transaction requires validation',
        );
      }

      return this.confirmPayment({
        tranId: input.tranId,
        valId: transaction.val_id,
        payload: input.payload,
      });
    }

    // A pending/unknown provider result is not a final failure.
    // Keep inventory reserved; reconciliation can check it later.
    if (transaction.status !== 'FAILED') {
      return {
        received: true,
        pendingReconciliation: true,
      };
    }

    if (
      transaction.amount !== undefined &&
      !new Prisma.Decimal(transaction.amount).equals(payment.amount)
    ) {
      throw new ConflictException('Payment amount mismatch');
    }

    if (
      transaction.currency_type !== undefined &&
      transaction.currency_type !== payment.currency
    ) {
      throw new ConflictException('Payment currency mismatch');
    }

    const providerEventId = `${input.tranId}:${transaction.status}`;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Record the event inside the same transaction.
          const event = await tx.paymentEvent.create({
            data: {
              provider: 'SSLCOMMERZ',
              providerEventId,
              paymentId: payment.id,
              eventType: 'PAYMENT_FAILED',
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

          if (currentPayment.status !== 'PROCESSING') {
            await tx.paymentEvent.update({
              where: { id: event.id },
              data: {
                status: 'PROCESSED',
                processedAt: new Date(),
              },
            });

            return {
              received: true,
              paymentStatus: currentPayment.status,
              alreadyFinal: true,
            };
          }

          const order = await tx.order.findUnique({
            where: { id: currentPayment.orderId },
            select: { status: true },
          });

          if (!order) {
            throw new NotFoundException('Order not found');
          }

          // Never change a confirmed order to cancelled.
          if (order.status === 'CONFIRMED') {
            throw new ConflictException(
              'Order is confirmed; payment requires reconciliation',
            );
          }

          // Cancel only a still-pending order.
          const cancelled = await tx.order.updateMany({
            where: {
              id: currentPayment.orderId,
              status: 'PENDING_PAYMENT',
            },
            data: {
              status: 'CANCELLED',
            },
          });

          // If the order was already cancelled by expiry, its
          // reservations may already be released. That is okay.
          if (cancelled.count === 1) {
            const reservations = await tx.inventoryReservation.findMany({
              where: {
                orderId: currentPayment.orderId,
                status: 'ACTIVE',
              },
            });

            for (const reservation of reservations) {
              const inventoryUpdate = await tx.inventory.updateMany({
                where: {
                  productId: reservation.productId,
                  reservedQuantity: {
                    gte: reservation.quantity,
                  },
                },
                data: {
                  availableQuantity: {
                    increment: reservation.quantity,
                  },
                  reservedQuantity: {
                    decrement: reservation.quantity,
                  },
                },
              });

              if (inventoryUpdate.count !== 1) {
                throw new ConflictException(
                  'Inventory reservation could not be released',
                );
              }

              const released = await tx.inventoryReservation.updateMany({
                where: {
                  id: reservation.id,
                  status: 'ACTIVE',
                },
                data: {
                  status: 'RELEASED',
                },
              });

              if (released.count !== 1) {
                throw new ConflictException(
                  'Reservation state changed unexpectedly',
                );
              }
            }
          } else if (order.status !== 'CANCELLED') {
            throw new ConflictException(
              'Order state does not allow payment failure processing',
            );
          }

          const failed = await tx.payment.updateMany({
            where: {
              id: currentPayment.id,
              status: 'PROCESSING',
            },
            data: {
              status: 'FAILED',
            },
          });

          if (failed.count !== 1) {
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
            paymentStatus: 'FAILED',
            orderStatus: cancelled.count === 1 ? 'CANCELLED' : 'CANCELLED',
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
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
