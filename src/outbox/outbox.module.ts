import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OutboxConsumerService } from './outbox-consumer.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';
import { RabbitMQTopologyService } from './rabbitmq-topology.service.js';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    RabbitMQTopologyService,
    OutboxPublisherService,
    OutboxConsumerService,
  ],
})
export class OutboxModule {}
