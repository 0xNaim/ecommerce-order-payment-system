import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { PrismaService } from '../prisma/prisma.service.js';

const NOTIFICATION_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
] as const;

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);

  readonly registry = new Registry();

  readonly deliveryTotal: Counter<'result'>;
  readonly deliveryDuration: Histogram<'result'>;
  readonly notificationJobs: Gauge<'status'>;
  readonly workerUp: Gauge<string>;

  constructor(private readonly prisma: PrismaService) {
    this.registry.setDefaultLabels({
      service: 'ecommerce-api',
    });

    collectDefaultMetrics({
      register: this.registry,
    });

    this.deliveryTotal = new Counter({
      name: 'notification_delivery_total',
      help: 'Notification delivery attempts by outcome.',
      labelNames: ['result'] as const,
      registers: [this.registry],
    });

    this.deliveryDuration = new Histogram({
      name: 'notification_delivery_duration_seconds',
      help: 'Time spent attempting notification delivery.',
      labelNames: ['result'] as const,
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
      registers: [this.registry],
    });

    this.notificationJobs = new Gauge({
      name: 'notification_jobs',
      help: 'Current notification jobs by database status.',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.workerUp = new Gauge({
      name: 'notification_worker_up',
      help: 'Whether the notification worker has SMTP configuration.',
      registers: [this.registry],
    });

    this.workerUp.set(0);

    for (const status of NOTIFICATION_STATUSES) {
      this.notificationJobs.set({ status }, 0);
    }
  }

  async onModuleInit(): Promise<void> {
    await this.refreshNotificationJobs();
  }

  @Cron('*/15 * * * * *')
  async refreshNotificationJobs(): Promise<void> {
    try {
      const groups = await this.prisma.notification.groupBy({
        by: ['status'],
        _count: {
          _all: true,
        },
      });

      const counts = new Map(
        groups.map((group) => [group.status, group._count._all]),
      );

      for (const status of NOTIFICATION_STATUSES) {
        this.notificationJobs.set({ status }, counts.get(status) ?? 0);
      }
    } catch (error) {
      this.logger.error(
        'Could not refresh notification queue metrics',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  setWorkerUp(isUp: boolean): void {
    this.workerUp.set(isUp ? 1 : 0);
  }

  recordDeliverySuccess(durationSeconds: number): void {
    this.deliveryTotal.inc({ result: 'success' });
    this.deliveryDuration.observe({ result: 'success' }, durationSeconds);
  }

  recordDeliveryFailure(durationSeconds: number, exhausted: boolean): void {
    const result = exhausted ? 'failed' : 'retry';

    this.deliveryTotal.inc({ result });
    this.deliveryDuration.observe({ result }, durationSeconds);
  }
}
