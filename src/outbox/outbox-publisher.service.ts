import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OutboxEvent } from '@prisma/client';
import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

const EXCHANGE = 'ecommerce.events';
const QUEUE = 'ecommerce.events';
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 20;

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);

  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');

    if (!url) {
      throw new Error('RABBITMQ_URL is not configured');
    }

    this.connection = await amqp.connect(url);
    this.channel = await this.connection.createConfirmChannel();

    await this.channel.assertExchange(EXCHANGE, 'topic', {
      durable: true,
    });

    // Ensure at least one durable queue receives every event.
    const queue = await this.channel.assertQueue(QUEUE, { durable: true });

    await this.channel.bindQueue(queue.queue, EXCHANGE, '#');

    this.connection.on('error', (error) => {
      this.logger.error('RabbitMQ connection error', error.message);
    });

    this.connection.on('close', () => {
      this.logger.warn('RabbitMQ connection closed');
      this.channel = undefined;
      this.connection = undefined;
      // A reconnect loop will be added in the reliability hardening phase.
    });
  }

  @Cron('*/2 * * * * *')
  async publishPendingEvents(): Promise<void> {
    if (this.running) return;

    if (!this.channel) {
      try {
        await this.connect();
      } catch (error) {
        this.logger.error(
          'RabbitMQ is unavailable',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }

    this.running = true;

    try {
      const events = await this.claimBatch();

      for (const event of events) {
        await this.publishOne(event);
      }
    } catch (error) {
      this.logger.error(
        'Outbox batch processing failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  private async claimBatch(): Promise<OutboxEvent[]> {
    const lockToken = randomUUID();

    return this.prisma.$queryRaw<OutboxEvent[]>`
      WITH candidates AS (
        SELECT id
        FROM outbox_events
        WHERE "publishedAt" IS NULL
          AND attempts < ${MAX_ATTEMPTS}
          AND (
            "nextAttemptAt" IS NULL
            OR "nextAttemptAt" <= NOW()
          )
          AND (
            "lockedAt" IS NULL
            OR "lockedAt" < NOW() - INTERVAL '2 minutes'
          )
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      )
      UPDATE outbox_events AS e
      SET
        "lockedAt" = NOW(),
        "lockToken" = ${lockToken}::uuid,
        attempts = e.attempts + 1
      FROM candidates
      WHERE e.id = candidates.id
      RETURNING e.*
    `;
  }

  private async publishOne(event: OutboxEvent): Promise<void> {
    const channel = this.channel;

    if (!channel) {
      await this.releaseForRetry(event, 'RabbitMQ channel unavailable');
      return;
    }

    try {
      const payload = Buffer.from(
        JSON.stringify({
          id: event.id,
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload,
          occurredAt: event.createdAt.toISOString(),
        }),
      );

      await new Promise<void>((resolve, reject) => {
        channel.publish(
          EXCHANGE,
          event.eventType,
          payload,
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId: event.id,
            type: event.eventType,
            timestamp: Date.now(),
          },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });

      // Update only if this worker still owns the claimed event.
      await this.prisma.outboxEvent.updateMany({
        where: {
          id: event.id,
          publishedAt: null,
          lockToken: event.lockToken,
        },
        data: {
          publishedAt: new Date(),
          lockedAt: null,
          lockToken: null,
          nextAttemptAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Outbox publish failed for ${event.id}: ${message}`);

      await this.releaseForRetry(event, message);
    }
  }

  private async releaseForRetry(
    event: OutboxEvent,
    errorMessage: string,
  ): Promise<void> {
    // Exponential backoff, capped at 15 minutes.
    const delaySeconds = Math.min(15 * 60, 2 ** Math.min(event.attempts, 10));

    await this.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        publishedAt: null,
        lockToken: event.lockToken,
      },
      data: {
        lockedAt: null,
        lockToken: null,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        lastError: errorMessage.slice(0, 2000),
      },
    });
  }
}
