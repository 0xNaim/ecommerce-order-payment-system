import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [PrismaModule, AuthModule, InventoryModule],
  providers: [OrdersService],
  exports: [OrdersService],
  controllers: [OrdersController],
})
export class OrdersModule {}
