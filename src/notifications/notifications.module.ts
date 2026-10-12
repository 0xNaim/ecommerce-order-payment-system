import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetricsModule } from '../metrics/metrics.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { NotificationWorkerService } from './notification-worker.service.js';

@Module({
  imports: [ConfigModule, PrismaModule, MetricsModule],
  providers: [NotificationWorkerService],
})
export class NotificationsModule {}
