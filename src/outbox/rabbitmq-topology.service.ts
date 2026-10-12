import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import { assertOutboxTopology } from './outbox.constants.js';

@Injectable()
export class RabbitMQTopologyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQTopologyService.name);

  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private connecting = false;

  constructor(private readonly config: ConfigService) {}

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

  @Cron('*/10 * * * * *')
  async reconnectIfNeeded(): Promise<void> {
    if (!this.channel) {
      await this.ensureConnected();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.channel || this.connecting) {
      return;
    }

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

        this.logger.warn('RabbitMQ topology connection closed');
      });

      const channel = await connection.createConfirmChannel();

      channel.on('error', (error) => {
        this.logger.error(`RabbitMQ topology channel error: ${error.message}`);
      });

      channel.on('close', () => {
        if (this.channel === channel) {
          this.channel = undefined;
        }
      });

      await assertOutboxTopology(channel);

      this.connection = connection;
      this.channel = channel;

      this.logger.log('RabbitMQ topology is ready');
    } catch (error) {
      this.logger.error(
        'Could not initialize RabbitMQ topology',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.connecting = false;
    }
  }
}
