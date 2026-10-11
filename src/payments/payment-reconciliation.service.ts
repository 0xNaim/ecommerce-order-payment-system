import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentsService } from './payments.service.js';
import { SSLCommerzProvider } from './providers/sslcommerz.provider.js';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  // Avoid checking a payment immediately after checkout.
  private readonly staleAfterMs = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly provider: SSLCommerzProvider,
  ) {}

  @Cron('0 */5 * * * *')
  async reconcileStalePayments(): Promise<void> {
    const cutoff = new Date(Date.now() - this.staleAfterMs);

    const payments = await this.prisma.payment.findMany({
      where: {
        provider: 'SSLCOMMERZ',
        status: 'PROCESSING',
        createdAt: { lte: cutoff },
        providerReference: { not: null },
      },
      select: {
        id: true,
        providerReference: true,
      },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });

    for (const payment of payments) {
      if (!payment.providerReference) {
        continue;
      }

      try {
        const result = await this.provider.queryTransaction(
          payment.providerReference,
        );

        if (result.tran_id !== payment.providerReference) {
          this.logger.warn(
            `Reconciliation ID mismatch for payment ${payment.id}`,
          );
          continue;
        }

        if (['VALID', 'VALIDATED'].includes(result.status)) {
          if (!result.val_id) {
            this.logger.warn(
              `Successful provider status without val_id: ${payment.id}`,
            );
            continue;
          }

          await this.paymentsService.confirmPayment({
            tranId: payment.providerReference,
            valId: result.val_id,
            payload: {
              source: 'reconciliation',
              status: result.status,
              tran_id: result.tran_id,
            },
          });

          continue;
        }

        if (result.status === 'FAILED') {
          await this.paymentsService.handleFailureNotification({
            tranId: payment.providerReference,
            ipnStatus: 'FAILED',
            payload: {
              source: 'reconciliation',
              status: result.status,
              tran_id: result.tran_id,
            },
          });

          continue;
        }

        // Pending, unknown, cancelled, or incomplete provider data:
        // do not release stock based on an uncertain result.
        this.logger.debug(
          `Payment ${payment.id} remains under reconciliation: ${result.status}`,
        );
      } catch (error) {
        this.logger.error(
          `Could not reconcile payment ${payment.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
