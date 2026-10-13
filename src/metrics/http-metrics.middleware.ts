import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/metrics') {
      next();
      return;
    }

    const method = req.method;
    const startedAt = process.hrtime.bigint();

    this.metrics.requestsInFlight.inc({ method });

    let completed = false;

    const finish = () => {
      if (completed) return;
      completed = true;

      this.metrics.requestsInFlight.dec({ method });

      // Use a route template instead of a raw URL containing IDs.
      const matchedRoute = req.route?.path;
      const route =
        typeof matchedRoute === 'string'
          ? `${req.baseUrl}${matchedRoute}`
          : 'unmatched';

      const labels = {
        method,
        route,
        status_code: String(res.statusCode),
      };

      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, durationSeconds);
    };

    res.once('finish', finish);
    res.once('close', finish);

    next();
  }
}
