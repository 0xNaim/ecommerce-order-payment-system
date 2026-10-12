import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { NotificationWorkerService } from './notification-worker.service.js';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [NotificationWorkerService],
})
export class NotificationsModule {}
