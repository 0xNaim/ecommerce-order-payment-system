import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const suppliedRequestId = req.headers['x-request-id'];

    // Trust an incoming ID only when it is a single, valid UUID.
    const requestId =
      typeof suppliedRequestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        suppliedRequestId,
      )
        ? suppliedRequestId
        : randomUUID();

    const startedAt = process.hrtime.bigint();

    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      const entry = {
        timestamp: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : 'info',
        message: 'HTTP request completed',
        requestId,
        method: req.method,
        // Do not log query strings; they may contain sensitive values.
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      };

      const serialized = JSON.stringify(entry);

      if (res.statusCode >= 500) {
        this.logger.error(serialized);
      } else {
        this.logger.log(serialized);
      }
    });

    next();
  }
}
