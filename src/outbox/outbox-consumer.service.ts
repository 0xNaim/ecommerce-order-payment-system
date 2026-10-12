import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import amqp, { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertOutboxTopology, OUTBOX_RABBITMQ } from './outbox.constants.js';

interface DomainEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: string;
}

@Injectable()
export class OutboxConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxConsumerService.name);

  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private consumerTag?: string;
  private connecting = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureConsumer();
  }

  async onModuleDestroy(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    const consumerTag = this.consumerTag;

    this.channel = undefined;
    this.connection = undefined;
    this.consumerTag = undefined;

    if (channel && consumerTag) {
      await channel.cancel(consumerTag).catch(() => undefined);
    }

    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }

  @Cron('*/5 * * * * *')
  async reconnectIfNeeded(): Promise<void> {
    if (!this.channel || !this.consumerTag) {
      await this.ensureConsumer();
    }
  }

  private async ensureConsumer(): Promise<void> {
    if (this.channel && this.consumerTag) return;
    if (this.connecting) return;

    this.connecting = true;

    try {
      const url = this.config.get<string>('RABBITMQ_URL');

      if (!url) {
        throw new Error('RABBITMQ_URL is not configured');
      }

      const connection = await amqp.connect(url);

      connection.on('error', (error) => {
        this.logger.error(
          `RabbitMQ consumer connection error: ${error.message}`,
        );
      });

      connection.on('close', () => {
        if (this.connection === connection) {
          this.connection = undefined;
          this.channel = undefined;
          this.consumerTag = undefined;
        }

        this.logger.warn('Consumer connection closed');
      });

      const channel = await connection.createConfirmChannel();

      channel.on('error', (error) => {
        this.logger.error(`RabbitMQ consumer channel error: ${error.message}`);
      });

      channel.on('close', () => {
        if (this.channel === channel) {
          this.channel = undefined;
          this.consumerTag = undefined;
        }
      });

      await assertOutboxTopology(channel);

      await channel.prefetch(OUTBOX_RABBITMQ.PREFETCH_COUNT);

      this.connection = connection;
      this.channel = channel;

      const result = await channel.consume(
        OUTBOX_RABBITMQ.MAIN_QUEUE,
        (message) => {
          if (message) {
            void this.handleMessage(channel, message);
          }
        },
        { noAck: false },
      );

      this.consumerTag = result.consumerTag;

      this.logger.log(`Consumer started: ${OUTBOX_RABBITMQ.MAIN_QUEUE}`);
    } catch (error) {
      this.logger.error(
        'Could not start RabbitMQ consumer',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.connecting = false;
    }
  }

  private async handleMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
  ): Promise<void> {
    let event: DomainEvent;

    try {
      event = JSON.parse(message.content.toString()) as DomainEvent;

      if (
        !event ||
        typeof event.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          event.id,
        ) ||
        typeof event.eventType !== 'string' ||
        typeof event.aggregateId !== 'string'
      ) {
        throw new Error('Invalid event envelope');
      }
    } catch (error) {
      this.logger.error(
        'Invalid event message; routing to DLQ',
        error instanceof Error ? error.message : String(error),
      );

      try {
        await this.publishAndConfirm(
          channel,
          OUTBOX_RABBITMQ.DEAD_LETTER_EXCHANGE,
          OUTBOX_RABBITMQ.DEAD_LETTER_ROUTING_KEY,
          message.content,
          {
            persistent: true,
            contentType: 'application/json',
            messageId: message.properties.messageId,
            headers: message.properties.headers,
          },
        );

        channel.ack(message);
      } catch {
        // Do not ACK if DLQ publication was not confirmed.
        await channel.close().catch(() => undefined);
      }

      return;
    }

    const retryCount = Number(
      message.properties.headers?.['x-retry-count'] ?? 0,
    );

    try {
      await this.persistEventAndNotification(event);

      channel.ack(message);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        channel.ack(message);
        return;
      }

      this.logger.error(
        `Processing failed for event ${event.id}`,
        error instanceof Error ? error.stack : String(error),
      );

      try {
        if (retryCount >= OUTBOX_RABBITMQ.MAX_CONSUMER_RETRIES) {
          await this.publishAndConfirm(
            channel,
            OUTBOX_RABBITMQ.DEAD_LETTER_EXCHANGE,
            OUTBOX_RABBITMQ.DEAD_LETTER_ROUTING_KEY,
            message.content,
            {
              persistent: true,
              contentType: 'application/json',
              messageId: event.id,
              headers: message.properties.headers,
            },
          );
        } else {
          await this.publishAndConfirm(
            channel,
            OUTBOX_RABBITMQ.RETRY_EXCHANGE,
            OUTBOX_RABBITMQ.RETRY_ROUTING_KEY,
            message.content,
            {
              persistent: true,
              contentType: 'application/json',
              messageId: event.id,
              type: event.eventType,
              headers: {
                ...message.properties.headers,
                'x-retry-count': retryCount + 1,
              },
            },
          );
        }

        // ACK only after retry/DLQ broker confirmation.
        channel.ack(message);
      } catch (publishError) {
        this.logger.error(
          'Retry/DLQ publish failed; closing channel to requeue original',
          publishError instanceof Error
            ? publishError.message
            : String(publishError),
        );

        await channel.close().catch(() => undefined);
      }
    }
  }

  private async persistEventAndNotification(event: DomainEvent): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Unique eventId prevents duplicate processing.
      // If anything below fails, this insert also rolls back.
      await tx.processedEvent.create({
        data: {
          eventId: event.id,
        },
      });

      if (event.eventType !== 'order.confirmed') {
        this.logger.log(
          `Processed ${event.eventType} for ${event.aggregateId}`,
        );

        return;
      }

      const order = await tx.order.findUnique({
        where: {
          id: event.aggregateId,
        },
        select: {
          id: true,
          orderNumber: true,
          totalAmount: true,
          currency: true,
          user: {
            select: {
              email: true,
            },
          },
        },
      });

      if (!order) {
        throw new Error(
          `Order not found for confirmation event: ${event.aggregateId}`,
        );
      }

      await tx.notification.create({
        data: {
          eventId: event.id,
          channel: 'EMAIL',
          status: 'PENDING',

          recipientEmail: order.user.email,
          template: 'order-confirmed',
          subject: `Order ${order.orderNumber} confirmed`,

          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            totalAmount: order.totalAmount.toString(),
            currency: order.currency,
          },
        },
      });

      this.logger.log(
        `Notification job created for order ${order.orderNumber}`,
      );
    });
  }

  private async publishAndConfirm(
    channel: ConfirmChannel,
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Record<string, unknown>,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        exchange,
        routingKey,
        content,
        options as amqp.Options.Publish,
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }
}
