import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getByProductId(productId: string) {
    const inventory = await this.prisma.inventory.findUnique({
      where: { productId },
      select: {
        productId: true,
        availableQuantity: true,
        reservedQuantity: true,
        updatedAt: true,
      },
    });

    if (!inventory) {
      throw new NotFoundException('Inventory not found');
    }

    return inventory;
  }

  async restock(productId: string, quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const result = await this.prisma.inventory.updateMany({
      where: { productId },
      data: {
        availableQuantity: { increment: quantity },
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Inventory not found');
    }

    return this.getByProductId(productId);
  }

  async reserveStock(
    tx: Prisma.TransactionClient,
    orderId: string,
    productId: string,
    quantity: number,
    expiresAt: Date,
  ): Promise<void> {
    if (Number.isSafeInteger(quantity) && quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const updated = await tx.$executeRaw`
    UPDATE "inventory"
    SET
      "availableQuantity" = "availableQuantity" - ${quantity},
      "reservedQuantity" = "reservedQuantity" + ${quantity},
      "updatedAt" = NOW()
    WHERE "productId" = ${productId}::uuid
      AND "availableQuantity" >= ${quantity}
  `;

    if (updated !== 1) {
      throw new BadRequestException(
        'Insufficient stock or inventory not found',
      );
    }

    await tx.inventoryReservation.create({
      data: {
        orderId,
        productId,
        quantity,
        expiresAt,
        status: 'ACTIVE',
      },
    });
  }
}
