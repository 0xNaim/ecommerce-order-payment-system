import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [OutboxPublisherService],
})
export class OutboxModule {}
