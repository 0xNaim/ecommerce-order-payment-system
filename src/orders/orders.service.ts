import { ConflictException, Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { InventoryService } from '../inventory/inventory.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';

export type OrderResponse = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: string;
  currency: string;
  items: {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  }[];
  createdAt: string;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryService: InventoryService,
  ) {}

  private normalizeItems(items: CreateOrderDto['items']) {
    const quantities = new Map<string, number>();

    for (const item of items) {
      const quantity = (quantities.get(item.productId) ?? 0) + item.quantity;

      if (!Number.isSafeInteger(quantity) || quantity > 100) {
        throw new ConflictException(
          'Aggregate product quantity exceeds the limit',
        );
      }

      quantities.set(item.productId, quantity);
    }

    return Array.from(quantities.entries())
      .map(([productId, quantity]) => ({
        productId,
        quantity,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId));
  }

  private hashRequest(items: ReturnType<OrdersService['normalizeItems']>) {
    return createHash('sha256').update(JSON.stringify(items)).digest('hex');
  }

  async createOrder(
    userId: string,
    idempotencyKey: string,
    dto: CreateOrderDto,
  ): Promise<OrderResponse> {
    if (
      !idempotencyKey ||
      idempotencyKey.length > 255 ||
      !/^[\x21-\x7E]+$/.test(idempotencyKey)
    ) {
      throw new ConflictException('Invalid idempotency key');
    }

    const items = this.normalizeItems(dto.items);
    const requestHash = this.hashRequest(items);

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        userId_key: {
          userId,
          key: idempotencyKey,
        },
      },
    });

    if (existing) {
      return this.replayOrReject(existing, requestHash);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.idempotencyRecord.create({
          data: {
            userId,
            key: idempotencyKey,
            requestHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });

        const products = await tx.product.findMany({
          where: {
            id: { in: items.map((item) => item.productId) },
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            price: true,
            currency: true,
          },
        });

        if (products.length !== items.length) {
          throw new ConflictException('One or more products are unavailable');
        }

        const productMap = new Map(
          products.map((product) => [product.id, product]),
        );

        const currencies = new Set(products.map((product) => product.currency));

        if (currencies.size !== 1) {
          throw new ConflictException('Products must use the same currency');
        }

        const currency = products[0].currency;
        let total = new Prisma.Decimal(0);

        for (const item of items) {
          const product = productMap.get(item.productId)!;

          total = total.plus(product.price.mul(item.quantity));
        }

        const order = await tx.order.create({
          data: {
            userId,
            status: OrderStatus.PENDING_PAYMENT,
            totalAmount: total,
            currency,
          },
        });

        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        for (const item of items) {
          const product = productMap.get(item.productId)!;

          await this.inventoryService.reserveStock(
            tx,
            order.id,
            item.productId,
            item.quantity,
            expiresAt,
          );

          await tx.orderItem.create({
            data: {
              orderId: order.id,
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: product.price,
              currency: product.currency,
            },
          });
        }

        await tx.outboxEvent.create({
          data: {
            eventType: 'order.created',
            aggregateType: 'Order',
            aggregateId: order.id,
            orderId: order.id,
            payload: {
              eventId: randomUUID(),
              orderId: order.id,
              orderNumber: order.orderNumber,
              userId,
              totalAmount: total.toFixed(2),
              currency,
            },
          },
        });

        const response: OrderResponse = {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          totalAmount: total.toFixed(2),
          currency,
          items: items.map((item) => {
            const product = productMap.get(item.productId)!;

            return {
              productId: item.productId,
              productName: product.name,
              quantity: item.quantity,
              unitPrice: product.price.toFixed(2),
              lineTotal: product.price.mul(item.quantity).toFixed(2),
            };
          }),
          createdAt: order.createdAt.toISOString(),
        };

        await tx.idempotencyRecord.update({
          where: {
            userId_key: {
              userId,
              key: idempotencyKey,
            },
          },
          data: {
            responseStatus: 201,
            responseBody: response,
          },
        });

        return response;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const record = await this.prisma.idempotencyRecord.findUnique({
          where: {
            userId_key: {
              userId,
              key: idempotencyKey,
            },
          },
        });

        if (record) {
          return this.replayOrReject(record, requestHash);
        }
      }

      throw error;
    }
  }

  private replayOrReject(
    record: {
      requestHash: string;
      responseBody: Prisma.JsonValue | null;
    },
    requestHash: string,
  ): OrderResponse {
    if (record.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency key was used with a different request',
      );
    }

    if (record.responseBody === null) {
      throw new ConflictException('Request is still being processed');
    }

    return record.responseBody as unknown as OrderResponse;
  }
}
