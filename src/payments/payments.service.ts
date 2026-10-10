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
