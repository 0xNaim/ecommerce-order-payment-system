import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { SSLCommerzProvider } from './providers/sslcommerz.provider.js';

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule],
  providers: [
    PaymentsService,
    SSLCommerzProvider,
    {
      provide: PAYMENT_PROVIDER,
      useExisting: SSLCommerzProvider,
    },
  ],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
