import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { OrdersService } from '../src/orders/orders.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Orders checkout (integration)', () => {
  let prisma: PrismaService;
  let ordersService: OrdersService;
  let userId: string;
  let productId: string;
  let productCurrency: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    ordersService = new OrdersService(prisma, new InventoryService(prisma));
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        email: `checkout-${randomUUID()}@example.test`,
        passwordHash: 'test-only-hash',
      },
    });

    userId = user.id;

    const product = await prisma.product.create({
      data: {
        name: 'Checkout Integration Product',
        slug: `checkout-${randomUUID()}`,
        price: new Prisma.Decimal('10.00'),
        inventory: {
          create: {
            availableQuantity: 10,
            reservedQuantity: 0,
          },
        },
      },
    });

    productId = product.id;
    productCurrency = product.currency;
  });

  afterEach(async () => {
    const orders = await prisma.order.findMany({
      where: { userId },
      select: { id: true },
    });

    const orderIds = orders.map((order) => order.id);

    if (orderIds.length > 0) {
      await prisma.paymentEvent.deleteMany({
        where: { payment: { orderId: { in: orderIds } } },
      });

      await prisma.payment.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      await prisma.inventoryReservation.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      await prisma.orderItem.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      await prisma.outboxEvent.deleteMany({
        where: { orderId: { in: orderIds } },
      });
    }

    await prisma.idempotencyRecord.deleteMany({
      where: { userId },
    });

    if (orderIds.length > 0) {
      await prisma.order.deleteMany({
        where: { id: { in: orderIds } },
      });
    }

    await prisma.inventory.deleteMany({
      where: { productId },
    });

    await prisma.product.deleteMany({
      where: { id: productId },
    });

    await prisma.user.deleteMany({
      where: { id: userId },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const checkout = (key: string, quantity = 1) =>
    ordersService.createOrder(userId, key, {
      items: [{ productId, quantity }],
    });

  it('creates an order, reserves stock and writes an outbox event', async () => {
    const response = await checkout(`success-${randomUUID()}`, 2);

    expect(response).toMatchObject({
      status: 'PENDING_PAYMENT',
      totalAmount: '20.00',
      currency: productCurrency,
      items: [
        {
          productId,
          quantity: 2,
          unitPrice: '10.00',
          lineTotal: '20.00',
        },
      ],
    });

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: response.id },
      include: {
        items: true,
        reservations: true,
      },
    });

    expect(order.items).toHaveLength(1);
    expect(order.reservations).toHaveLength(1);
    expect(order.reservations[0].quantity).toBe(2);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    expect(inventory.availableQuantity).toBe(8);
    expect(inventory.reservedQuantity).toBe(2);

    expect(
      await prisma.outboxEvent.count({
        where: {
          orderId: response.id,
          eventType: 'order.created',
        },
      }),
    ).toBe(1);

    expect(
      await prisma.idempotencyRecord.count({
        where: { userId },
      }),
    ).toBe(1);
  });

  it('replays the original response for the same key and payload', async () => {
    const key = `replay-${randomUUID()}`;

    const first = await checkout(key, 2);
    const second = await checkout(key, 2);

    expect(second).toEqual(first);

    expect(await prisma.order.count({ where: { userId } })).toBe(1);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    expect(inventory.availableQuantity).toBe(8);
    expect(inventory.reservedQuantity).toBe(2);
  });

  it('rejects a different payload using the same idempotency key', async () => {
    const key = `conflict-${randomUUID()}`;

    const first = await checkout(key, 1);

    await expect(checkout(key, 2)).rejects.toBeInstanceOf(ConflictException);

    expect(await prisma.order.count({ where: { userId } })).toBe(1);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    expect(inventory.availableQuantity).toBe(9);
    expect(inventory.reservedQuantity).toBe(1);

    expect(
      await prisma.outboxEvent.count({
        where: { orderId: first.id },
      }),
    ).toBe(1);
  });

  it('rolls back all database changes when stock is insufficient', async () => {
    await prisma.inventory.update({
      where: { productId },
      data: {
        availableQuantity: 1,
        reservedQuantity: 0,
      },
    });

    const key = `insufficient-${randomUUID()}`;

    await expect(checkout(key, 2)).rejects.toBeInstanceOf(ConflictException);

    expect(await prisma.order.count({ where: { userId } })).toBe(0);

    expect(
      await prisma.idempotencyRecord.count({
        where: { userId },
      }),
    ).toBe(0);

    expect(
      await prisma.inventoryReservation.count({
        where: { productId },
      }),
    ).toBe(0);

    expect(
      await prisma.outboxEvent.count({
        where: {
          eventType: 'order.created',
          payload: { path: ['userId'], equals: userId },
        },
      }),
    ).toBe(0);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    expect(inventory.availableQuantity).toBe(1);
    expect(inventory.reservedQuantity).toBe(0);
  });

  it('does not oversell when two checkouts compete for one unit', async () => {
    await prisma.inventory.update({
      where: { productId },
      data: {
        availableQuantity: 1,
        reservedQuantity: 0,
      },
    });

    const results = await Promise.allSettled([
      checkout(`concurrent-a-${randomUUID()}`, 1),
      checkout(`concurrent-b-${randomUUID()}`, 1),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    expect(inventory.availableQuantity).toBe(0);
    expect(inventory.reservedQuantity).toBe(1);

    expect(await prisma.order.count({ where: { userId } })).toBe(1);

    expect(
      await prisma.inventoryReservation.count({
        where: { productId, status: 'ACTIVE' },
      }),
    ).toBe(1);

    expect(
      await prisma.outboxEvent.count({
        where: {
          eventType: 'order.created',
          payload: { path: ['userId'], equals: userId },
        },
      }),
    ).toBe(1);
  });
});
