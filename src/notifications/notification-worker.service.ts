import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import nodemailer, { Transporter } from 'nodemailer';
import { MetricsService } from '../metrics/metrics.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const LOCK_TIMEOUT_MINUTES = 2;
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1_000;

interface ClaimedNotification {
  id: string;
  recipientEmail: string;
  template: string;
  subject: string;
  payload: Prisma.JsonValue;
  attempts: number;
  lockToken: string;
}

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

@Injectable()
export class NotificationWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorkerService.name);

  private readonly transporter?: Transporter;
  private readonly fromAddress?: string;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    const host = config.get<string>('SMTP_HOST');
    const port = Number(config.get<string>('SMTP_PORT'));
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');
    const from = config.get<string>('SMTP_FROM');
    const secureValue = config.get<string>('SMTP_SECURE');

    const configured =
      Boolean(host) &&
      Number.isInteger(port) &&
      port > 0 &&
      Boolean(user) &&
      Boolean(pass) &&
      Boolean(from);

    if (!configured) {
      this.logger.warn(
        'SMTP is not configured. Notification jobs will remain pending.',
      );
      this.metrics.setWorkerUp(false);
      return;
    }

    this.fromAddress = from;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure:
        secureValue === undefined
          ? port === 465
          : secureValue.toLowerCase() === 'true',
      auth: { user, pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    this.metrics.setWorkerUp(Boolean(this.transporter && this.fromAddress));
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
  }

  @Cron('*/5 * * * * *')
  async pollNotifications(): Promise<void> {
    if (!this.transporter || !this.fromAddress || this.polling) {
      return;
    }

    this.polling = true;

    try {
      const jobs = await this.claimBatch();

      if (jobs.length > 0) {
        this.logger.log(`Claimed ${jobs.length} notification job(s)`);
      }

      await Promise.all(jobs.map((job) => this.deliver(job)));
    } catch (error) {
      this.logger.error(
        'Notification worker polling failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.polling = false;
    }
  }

  private async claimBatch(): Promise<ClaimedNotification[]> {
    const lockToken = randomUUID();

    // A worker that crashed on its final attempt must not retry forever.
    await this.prisma.$executeRaw`
      UPDATE notifications
      SET
        status = 'FAILED',
        "lockedAt" = NULL,
        "lockToken" = NULL,
        "lastError" = COALESCE(
          "lastError",
          'Worker lease expired after maximum attempts'
        ),
        "updatedAt" = NOW()
      WHERE
        status = 'PROCESSING'
        AND "lockedAt" < NOW() - INTERVAL '2 minutes'
        AND attempts >= ${MAX_ATTEMPTS}
    `;

    return this.prisma.$queryRaw<ClaimedNotification[]>`
      WITH candidates AS (
        SELECT id
        FROM notifications
        WHERE
          (
            status = 'PENDING'
            AND "nextAttemptAt" <= NOW()
          )
          OR
          (
            status = 'PROCESSING'
            AND "lockedAt" < NOW() - INTERVAL '2 minutes'
            AND attempts < ${MAX_ATTEMPTS}
          )
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      )
      UPDATE notifications AS n
      SET
        status = 'PROCESSING',
        "lockedAt" = NOW(),
        "lockToken" = ${lockToken}::uuid,
        attempts = n.attempts + 1,
        "updatedAt" = NOW()
      FROM candidates AS c
      WHERE n.id = c.id
      RETURNING
        n.id,
        n."recipientEmail",
        n.template,
        n.subject,
        n.payload,
        n.attempts,
        n."lockToken"::text AS "lockToken"
    `;
  }

  private async deliver(job: ClaimedNotification): Promise<void> {
    const startedAt = Date.now();
    let email: RenderedEmail;

    try {
      email = this.renderEmail(job);

      const info = await this.transporter!.sendMail({
        from: this.fromAddress!,
        to: job.recipientEmail,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: {
          'X-Notification-ID': job.id,
        },
      });

      // sendMail can resolve even when the recipient was rejected.
      if (!Array.isArray(info.accepted) || info.accepted.length === 0) {
        throw new Error('SMTP server did not accept the recipient');
      }
    } catch (error) {
      await this.recordFailure(job, error, startedAt);
      return;
    }

    this.metrics.recordDeliverySuccess((Date.now() - startedAt) / 1000);

    try {
      const result = await this.prisma.notification.updateMany({
        where: {
          id: job.id,
          status: 'PROCESSING',
          lockToken: job.lockToken,
        },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          lockedAt: null,
          lockToken: null,
          lastError: null,
        },
      });

      if (result.count === 0) {
        this.logger.warn(
          `Email accepted by SMTP, but job ${job.id} no longer has this worker's lock`,
        );
        return;
      }

      this.logger.log(
        `Notification ${job.id} accepted by SMTP for ${job.recipientEmail}`,
      );
    } catch (error) {
      // Do not classify a successfully accepted email as a known SMTP failure.
      // The lease will expire if the database update never succeeds.
      this.logger.error(
        `Email was accepted by SMTP, but SENT status could not be saved for ${job.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async recordFailure(
    job: ClaimedNotification,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const exhausted = job.attempts >= MAX_ATTEMPTS;

    this.metrics.recordDeliveryFailure(
      (Date.now() - startedAt) / 1000,
      exhausted,
    );

    const message = error instanceof Error ? error.message : String(error);

    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (job.attempts - 1),
      MAX_RETRY_DELAY_MS,
    );

    try {
      const result = await this.prisma.notification.updateMany({
        where: {
          id: job.id,
          status: 'PROCESSING',
          lockToken: job.lockToken,
        },
        data: {
          status: exhausted ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(Date.now() + delayMs),
          lockedAt: null,
          lockToken: null,
          lastError: message.slice(0, 2_000),
        },
      });

      if (result.count === 0) {
        this.logger.warn(
          `Could not update notification ${job.id}; its lock may have expired`,
        );
        return;
      }

      if (exhausted) {
        this.logger.error(
          `Notification ${job.id} exhausted ${MAX_ATTEMPTS} attempts: ${message}`,
        );
      } else {
        this.logger.warn(
          `Notification ${job.id} failed on attempt ${job.attempts}; retry scheduled`,
        );
      }
    } catch (updateError) {
      this.logger.error(
        `Failed to persist delivery failure for notification ${job.id}`,
        updateError instanceof Error ? updateError.stack : String(updateError),
      );
    }
  }

  private renderEmail(job: ClaimedNotification): RenderedEmail {
    if (job.template !== 'order-confirmed') {
      throw new Error(`Unsupported email template: ${job.template}`);
    }

    const payload = job.payload;

    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error('Invalid order-confirmation email payload');
    }

    const data = payload as Prisma.JsonObject;
    const orderNumber = String(data.orderNumber ?? '');
    const totalAmount = String(data.totalAmount ?? '');
    const currency = String(data.currency ?? '');

    if (!orderNumber || !totalAmount || !currency) {
      throw new Error('Missing required order-confirmation fields');
    }

    const safeOrderNumber = this.escapeHtml(orderNumber);
    const safeTotalAmount = this.escapeHtml(totalAmount);
    const safeCurrency = this.escapeHtml(currency);

    return {
      subject: job.subject.replace(/[\r\n]+/g, ' ').slice(0, 255),
      text: [
        `Your order ${orderNumber} has been confirmed.`,
        `Total: ${totalAmount} ${currency}`,
      ].join('\n'),
      html: `
        <!doctype html>
        <html>
          <body>
            <h2>Order confirmed</h2>
            <p>Your order <strong>${safeOrderNumber}</strong>
              has been confirmed.</p>
            <p>Total: ${safeTotalAmount} ${safeCurrency}</p>
            <p>Thank you for your purchase.</p>
          </body>
        </html>
      `,
    };
  }

  private escapeHtml(value: string): string {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return value.replace(/[&<>"']/g, (character) => entities[character]);
  }
}
