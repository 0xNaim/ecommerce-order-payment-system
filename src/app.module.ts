import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module.js';
import { RequestLoggingMiddleware } from './common/middleware/request-logging.middleware.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { HttpMetricsMiddleware } from './metrics/http-metrics.middleware.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductsModule } from './products/products.module.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    ProductsModule,
    InventoryModule,
    OrdersModule,
    AuthModule,
    PaymentsModule,
    OutboxModule,
    NotificationsModule,
    MetricsModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestLoggingMiddleware, HttpMetricsMiddleware)
      .forRoutes('*');
  }
}
