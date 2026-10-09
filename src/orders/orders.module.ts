import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [PrismaModule, InventoryModule],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
