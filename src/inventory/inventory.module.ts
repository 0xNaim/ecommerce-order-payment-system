import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { InventoryService } from './inventory.service.js';
import { ReservationExpiryService } from './reservation-expiry.service.js';

@Module({
  imports: [PrismaModule],
  providers: [InventoryService, ReservationExpiryService],
  exports: [InventoryService],
})
export class InventoryModule {}
