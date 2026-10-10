import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { SandboxPaymentProvider } from './sandbox-payment.provider.js';

@Injectable()
export class PaymentsService {
  private readonly provider = new SandboxPaymentProvider();

  constructor(private readonly prisma: PrismaService) {}

  async createIntent(userId: string, orderId: string, clientKey: string) {
    if (
      !clientKey ||
      clientKey.length > 255 ||
      !/^[\x21-\x7E]+$/.test(clientKey)
    ) {
      throw new ConflictException('Invalid idempotency key');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const provider = 'sandbox';
    const idempotencyKey = createHash('sha256')
      .update(`${userId}:${orderId}:${clientKey}`)
      .digest('hex');

    if (order.status !== 'PENDING_PAYMENT') {
      throw new ConflictException('Order does not accept payment');
    }

    let payment = await this.prisma.payment.findUnique({
      where: {
        provider_idempotencyKey: {
          provider,
          idempotencyKey,
        },
      },
    });

    if (payment && payment.orderId !== orderId) {
      throw new ConflictException('Idempotency key conflict');
    }

    if (payment?.status === 'SUCCEEDED') {
      return {
        paymentId: payment.id,
        status: payment.status,
        providerReference: payment.providerReference,
      };
    }

    if (!payment) {
      try {
        payment = await this.prisma.payment.create({
          data: {
            orderId,
            provider,
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
                provider,
                idempotencyKey,
              },
            },
          });
        }

        if (!payment) throw error;
      }
    }

    if (payment.status === 'FAILED' || payment.status === 'CANCELLED') {
      throw new ConflictException(
        'This payment attempt is terminal; use an explicit retry policy',
      );
    }

    if (payment.providerReference) {
      return {
        paymentId: payment.id,
        status: payment.status,
        providerReference: payment.providerReference,
      };
    }

    // External provider calls must not run inside a DB transaction.
    const intent = await this.provider.createIntent({
      paymentId: payment.id,
      amount: payment.amount.toFixed(2),
      currency: payment.currency,
      idempotencyKey,
    });

    payment = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerReference: intent.providerReference,
      },
    });

    return {
      paymentId: payment.id,
      status: payment.status,
      providerReference: payment.providerReference,
    };
  }
}
