import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class ReservationExpiryService {
  private readonly logger = new Logger(ReservationExpiryService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async releaseExpiredReservations(): Promise<void> {
    const now = new Date();

    const expired = await this.prisma.inventoryReservation.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lte: now },
      },
      select: { orderId: true },
      distinct: ['orderId'],
      take: 100,
    });

    for (const item of expired) {
      try {
        await this.expireOrder(item.orderId, now);
      } catch (error) {
        this.logger.error(
          `Failed to expire order ${item.orderId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async expireOrder(orderId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // Conditional update: if payment confirmation already won,
        // this update affects zero rows and stock must not be released.
        const cancelled = await tx.order.updateMany({
          where: {
            id: orderId,
            status: 'PENDING_PAYMENT',
          },
          data: {
            status: 'CANCELLED',
          },
        });

        if (cancelled.count === 0) {
          return;
        }

        const reservations = await tx.inventoryReservation.findMany({
          where: {
            orderId,
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
            throw new Error(
              `Inventory invariant failed for product ${reservation.productId}`,
            );
          }

          const reservationUpdate = await tx.inventoryReservation.updateMany({
            where: {
              id: reservation.id,
              status: 'ACTIVE',
            },
            data: {
              status: 'RELEASED',
            },
          });

          if (reservationUpdate.count !== 1) {
            throw new Error(`Reservation state changed: ${reservation.id}`);
          }
        }

        // Mark only an unfinished payment as expired.
        await tx.payment.updateMany({
          where: {
            orderId,
            status: 'PROCESSING',
          },
          data: {
            status: 'EXPIRED',
          },
        });

        // Any exception above rolls back order, inventory,
        // reservation and payment changes together.
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    this.logger.log(`Processed reservation expiry for order ${orderId}`);
  }
}
