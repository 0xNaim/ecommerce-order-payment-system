import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Inventory concurrency (integration)', () => {
  let prisma: PrismaService;
  let inventoryService: InventoryService;

  let userId: string;
  let productId: string;
  let orderIds: string[];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    inventoryService = new InventoryService(prisma);

    const user = await prisma.user.create({
      data: {
        email: `inventory-${randomUUID()}@example.test`,
        passwordHash: 'test-only-hash',
      },
    });
    userId = user.id;

    const product = await prisma.product.create({
      data: {
        name: 'Concurrency Test Product',
        slug: `concurrency-${randomUUID()}`,
        price: new Prisma.Decimal('10.00'),
        inventory: {
          create: {
            availableQuantity: 1,
            reservedQuantity: 0,
          },
        },
      },
    });
    productId = product.id;

    const orders = await Promise.all(
      [1, 2].map(() =>
        prisma.order.create({
          data: {
            userId,
            totalAmount: new Prisma.Decimal('10.00'),
          },
        }),
      ),
    );

    orderIds = orders.map((order) => order.id);
  });

  afterAll(async () => {
    if (orderIds?.length) {
      await prisma.inventoryReservation.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      await prisma.orderItem.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      await prisma.outboxEvent.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      await prisma.paymentEvent.deleteMany({
        where: { payment: { orderId: { in: orderIds } } },
      });

      await prisma.payment.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      await prisma.order.deleteMany({
        where: { id: { in: orderIds } },
      });
    }

    if (productId) {
      await prisma.inventory.deleteMany({
        where: { productId },
      });

      await prisma.product.deleteMany({
        where: { id: productId },
      });
    }

    if (userId) {
      await prisma.user.deleteMany({
        where: { id: userId },
      });
    }

    await prisma.$disconnect();
  });

  it('allows only one reservation when stock is one', async () => {
    const results = await Promise.allSettled(
      orderIds.map((orderId) =>
        prisma.$transaction((tx) =>
          inventoryService.reserveStock(
            tx,
            orderId,
            productId,
            1,
            new Date(Date.now() + 15 * 60 * 1000),
          ),
        ),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    const failures = results.filter((result) => result.status === 'rejected');

    expect(failures).toHaveLength(1);

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    expect(inventory.availableQuantity).toBe(0);
    expect(inventory.reservedQuantity).toBe(1);

    const reservations = await prisma.inventoryReservation.count({
      where: {
        productId,
        status: 'ACTIVE',
      },
    });

    expect(reservations).toBe(1);
  });
});
