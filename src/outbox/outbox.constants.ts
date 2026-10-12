import type { ConfirmChannel } from 'amqplib';

export const OUTBOX_RABBITMQ = {
  EXCHANGE: 'ecommerce.events',
  EXCHANGE_TYPE: 'topic',

  MAIN_QUEUE: 'ecommerce.events',
  MAIN_ROUTING_KEY: '#',

  RETRY_EXCHANGE: 'ecommerce.retry',
  RETRY_ROUTING_KEY: 'retry',
  RETRY_QUEUE: 'ecommerce.events.retry',
  RETRY_DELAY_MS: 10_000,

  DEAD_LETTER_EXCHANGE: 'ecommerce.dlx',
  DEAD_LETTER_ROUTING_KEY: 'failed',
  DEAD_LETTER_QUEUE: 'ecommerce.events.dlq',

  BATCH_SIZE: 50,
  MAX_PUBLISH_ATTEMPTS: 20,
  MAX_CONSUMER_RETRIES: 5,
  PREFETCH_COUNT: 10,
  LOCK_TIMEOUT_MINUTES: 2,
} as const;

/**
 * The ONLY place where queue arguments are defined.
 * Every service calls this function instead of declaring
 * queues independently with potentially different options.
 */
export async function assertOutboxTopology(
  channel: ConfirmChannel,
): Promise<void> {
  await channel.assertExchange(OUTBOX_RABBITMQ.EXCHANGE, 'topic', {
    durable: true,
  });

  await channel.assertExchange(OUTBOX_RABBITMQ.RETRY_EXCHANGE, 'direct', {
    durable: true,
  });

  await channel.assertExchange(OUTBOX_RABBITMQ.DEAD_LETTER_EXCHANGE, 'direct', {
    durable: true,
  });

  await channel.assertQueue(OUTBOX_RABBITMQ.MAIN_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': OUTBOX_RABBITMQ.DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': OUTBOX_RABBITMQ.DEAD_LETTER_ROUTING_KEY,
    },
  });

  await channel.bindQueue(
    OUTBOX_RABBITMQ.MAIN_QUEUE,
    OUTBOX_RABBITMQ.EXCHANGE,
    OUTBOX_RABBITMQ.MAIN_ROUTING_KEY,
  );

  await channel.assertQueue(OUTBOX_RABBITMQ.RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': OUTBOX_RABBITMQ.RETRY_DELAY_MS,
      'x-dead-letter-exchange': OUTBOX_RABBITMQ.EXCHANGE,
      'x-dead-letter-routing-key': 'retry',
    },
  });

  await channel.bindQueue(
    OUTBOX_RABBITMQ.RETRY_QUEUE,
    OUTBOX_RABBITMQ.RETRY_EXCHANGE,
    OUTBOX_RABBITMQ.RETRY_ROUTING_KEY,
  );

  await channel.assertQueue(OUTBOX_RABBITMQ.DEAD_LETTER_QUEUE, {
    durable: true,
  });

  await channel.bindQueue(
    OUTBOX_RABBITMQ.DEAD_LETTER_QUEUE,
    OUTBOX_RABBITMQ.DEAD_LETTER_EXCHANGE,
    OUTBOX_RABBITMQ.DEAD_LETTER_ROUTING_KEY,
  );
}
