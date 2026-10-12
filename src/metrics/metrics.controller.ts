import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  async getMetrics(@Res() response: Response): Promise<void> {
    response
      .status(200)
      .type(this.metrics.registry.contentType)
      .send(await this.metrics.registry.metrics());
  }
}
