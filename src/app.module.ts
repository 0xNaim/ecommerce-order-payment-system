import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductsModule } from './products/products.module.js';
import { InventoryModule } from './inventory/inventory.module.js';

@Module({
  imports: [PrismaModule, ProductsModule, InventoryModule],
})
export class AppModule {}
