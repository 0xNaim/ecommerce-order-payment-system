import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Liveness: the application process is responding.
  @Get('live')
  live() {
    return {
      status: 'ok',
      check: 'liveness',
      timestamp: new Date().toISOString(),
    };
  }

  // Readiness: the application can reach its database.
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ok',
        check: 'readiness',
        dependencies: {
          database: 'up',
        },
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        check: 'readiness',
        dependencies: {
          database: 'down',
        },
      });
    }
  }
}
