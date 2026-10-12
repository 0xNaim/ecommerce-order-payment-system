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
import { assertOutboxTopology, OUTBOX_RABBITMQ } from './outbox.constants.js';

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);

  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private connecting = false;
  private running = false;

  private readonly returnedMessageIds = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureConnected();
  }

  async onModuleDestroy(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;

    this.channel = undefined;
    this.connection = undefined;

    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }

  @Cron('*/2 * * * * *')
  async publishPendingEvents(): Promise<void> {
    if (this.running) return;

    await this.ensureConnected();

    if (!this.channel) return;

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

  private async ensureConnected(): Promise<void> {
    if (this.channel || this.connecting) return;

    this.connecting = true;

    try {
      const url = this.config.get<string>('RABBITMQ_URL');

      if (!url) {
        throw new Error('RABBITMQ_URL is not configured');
      }

      const connection = await amqp.connect(url);

      connection.on('error', (error) => {
        this.logger.error(`RabbitMQ connection error: ${error.message}`);
      });

      connection.on('close', () => {
        if (this.connection === connection) {
          this.connection = undefined;
          this.channel = undefined;
        }

        this.logger.warn('Publisher connection closed');
      });

      const channel = await connection.createConfirmChannel();

      channel.on('error', (error) => {
        this.logger.error(`Publisher channel error: ${error.message}`);
      });

      channel.on('close', () => {
        if (this.channel === channel) {
          this.channel = undefined;
        }
      });

      channel.on('return', (message) => {
        const messageId = message.properties.messageId;

        if (messageId) {
          this.returnedMessageIds.add(messageId);
        }

        this.logger.error(
          `Unroutable outbox message: ${messageId ?? 'unknown'}`,
        );
      });

      // Every publishing channel declares the same topology.
      await assertOutboxTopology(channel);

      this.connection = connection;
      this.channel = channel;

      this.logger.log('Outbox publisher connected to RabbitMQ');
    } catch (error) {
      this.logger.error(
        'Outbox publisher connection failed',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.connecting = false;
    }
  }

  private async claimBatch(): Promise<OutboxEvent[]> {
    const lockToken = randomUUID();

    return this.prisma.$queryRaw<OutboxEvent[]>`
      WITH candidates AS (
        SELECT id
        FROM outbox_events
        WHERE "publishedAt" IS NULL
          AND attempts < ${OUTBOX_RABBITMQ.MAX_PUBLISH_ATTEMPTS}
          AND (
            "nextAttemptAt" IS NULL
            OR "nextAttemptAt" <= NOW()
          )
          AND (
            "lockedAt" IS NULL
            OR "lockedAt" < NOW() - (
              ${OUTBOX_RABBITMQ.LOCK_TIMEOUT_MINUTES}
              * INTERVAL '1 minute'
            )
          )
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${OUTBOX_RABBITMQ.BATCH_SIZE}
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
      await this.scheduleRetry(event, 'RabbitMQ channel unavailable');
      return;
    }

    try {
      const content = Buffer.from(
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
          OUTBOX_RABBITMQ.EXCHANGE,
          event.eventType,
          content,
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId: event.id,
            type: event.eventType,
            timestamp: Date.now(),
          },
          (error) => {
            if (error) {
              reject(error);
              return;
            }

            // RabbitMQ emits "return" before the corresponding
            // publisher confirm for an unroutable mandatory message.
            if (this.returnedMessageIds.delete(event.id)) {
              reject(new Error('RabbitMQ could not route the message'));
              return;
            }

            resolve();
          },
        );
      });

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

      this.logger.error(`Outbox event ${event.id} publish failed: ${message}`);

      await this.scheduleRetry(event, message);
    }
  }

  private async scheduleRetry(
    event: OutboxEvent,
    errorMessage: string,
  ): Promise<void> {
    const seconds = Math.min(15 * 60, 2 ** Math.min(event.attempts, 10));

    await this.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        publishedAt: null,
        lockToken: event.lockToken,
      },
      data: {
        lockedAt: null,
        lockToken: null,
        nextAttemptAt: new Date(Date.now() + seconds * 1000),
        lastError: errorMessage.slice(0, 2000),
      },
    });
  }
}
