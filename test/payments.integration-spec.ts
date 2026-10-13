import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

import { InventoryService } from '../src/inventory/inventory.service.js';
import { OrdersService } from '../src/orders/orders.service.js';
import type { PaymentProvider } from '../src/payments/payment-provider.interface.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Payment verification security (integration)', () => {
  let prisma: PrismaService;
  let ordersService: OrdersService;
  let paymentsService: PaymentsService;

  let userId: string;
  let productId: string;
  let orderId: string;
  let paymentId: string;
  let tranId: string;
  let valId: string;

  let validatedTransaction: {
    status: string;
    tran_id: string;
    val_id: string;
    amount: string;
    currency: string;
    currency_type: string;
  };

  const provider: PaymentProvider = {
    createIntent: async () => ({
      providerReference: 'unused',
      checkoutUrl: 'https://example.test/checkout',
      sessionKey: 'test-session',
    }),

    validateTransaction: async () => validatedTransaction,

    queryTransaction: async () => ({
      status: 'PENDING',
      tran_id: tranId,
    }),
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    ordersService = new OrdersService(prisma, new InventoryService(prisma));

    paymentsService = new PaymentsService(prisma, provider);
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        email: `payment-test-${randomUUID()}@example.test`,
        passwordHash: 'test-only-hash',
      },
    });

    userId = user.id;

    const product = await prisma.product.create({
      data: {
        name: 'Payment Security Test Product',
        slug: `payment-test-${randomUUID()}`,
        price: new Prisma.Decimal('10.00'),
        inventory: {
          create: {
            availableQuantity: 5,
            reservedQuantity: 0,
          },
        },
      },
    });

    productId = product.id;

    const order = await ordersService.createOrder(
      userId,
      `checkout-${randomUUID()}`,
      {
        items: [{ productId, quantity: 1 }],
      },
    );

    orderId = order.id;
    tranId = `PAY_${randomUUID().replaceAll('-', '')}`;
    valId = `VAL_${randomUUID()}`;

    const payment = await prisma.payment.create({
      data: {
        orderId,
        provider: 'SSLCOMMERZ',
        idempotencyKey: randomUUID(),
        providerReference: tranId,
        amount: new Prisma.Decimal(order.totalAmount),
        currency: order.currency,
        status: 'PROCESSING',
      },
    });

    paymentId = payment.id;

    validatedTransaction = {
      status: 'VALID',
      tran_id: tranId,
      val_id: valId,
      amount: order.totalAmount,
      currency: order.currency,
      currency_type: order.currency,
    };
  });

  afterEach(async () => {
    if (paymentId) {
      await prisma.paymentEvent.deleteMany({
        where: { paymentId },
      });
    }

    if (orderId) {
      await prisma.payment.deleteMany({
        where: { orderId },
      });

      await prisma.inventoryReservation.deleteMany({
        where: { orderId },
      });

      await prisma.orderItem.deleteMany({
        where: { orderId },
      });

      await prisma.outboxEvent.deleteMany({
        where: { orderId },
      });

      await prisma.idempotencyRecord.deleteMany({
        where: { userId },
      });

      await prisma.order.deleteMany({
        where: { id: orderId },
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

    paymentId = '';
    orderId = '';
    productId = '';
    userId = '';
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const confirm = () =>
    paymentsService.confirmPayment({
      tranId,
      valId,
      payload: {
        status: 'VALID',
        tran_id: tranId,
        val_id: valId,
      },
    });

  it('rejects a provider transaction with an invalid status', async () => {
    validatedTransaction.status = 'FAILED';

    await expect(confirm()).rejects.toBeInstanceOf(ConflictException);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    expect(payment.status).toBe('PROCESSING');
    expect(order.status).toBe('PENDING_PAYMENT');

    expect(await prisma.paymentEvent.count({ where: { paymentId } })).toBe(0);
  });

  it('rejects a mismatched provider transaction ID', async () => {
    validatedTransaction.tran_id = 'PAY_DIFFERENT_TRANSACTION';

    await expect(confirm()).rejects.toBeInstanceOf(ConflictException);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    expect(payment.status).toBe('PROCESSING');
    expect(await prisma.paymentEvent.count({ where: { paymentId } })).toBe(0);
  });

  it('rejects a mismatched validation ID', async () => {
    validatedTransaction.val_id = 'VAL_DIFFERENT';

    await expect(confirm()).rejects.toBeInstanceOf(ConflictException);

    expect(await prisma.paymentEvent.count({ where: { paymentId } })).toBe(0);
  });

  it('rejects an amount mismatch', async () => {
    validatedTransaction.amount = '1.00';

    await expect(confirm()).rejects.toThrow('Payment amount mismatch');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    expect(payment.status).toBe('PROCESSING');

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    expect(order.status).toBe('PENDING_PAYMENT');

    expect(await prisma.paymentEvent.count({ where: { paymentId } })).toBe(0);
  });

  it('rejects a currency mismatch', async () => {
    validatedTransaction.currency_type = 'INVALID_CURRENCY';
    validatedTransaction.currency = 'INVALID_CURRENCY';

    await expect(confirm()).rejects.toThrow('Payment currency mismatch');

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    expect(order.status).toBe('PENDING_PAYMENT');

    expect(await prisma.paymentEvent.count({ where: { paymentId } })).toBe(0);
  });

  it('confirms a verified payment and commits the reservation', async () => {
    await confirm();

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    const reservation = await prisma.inventoryReservation.findFirstOrThrow({
      where: { orderId },
    });

    expect(payment.status).toBe('SUCCEEDED');
    expect(order.status).toBe('CONFIRMED');

    expect(inventory.availableQuantity).toBe(4);
    expect(inventory.reservedQuantity).toBe(0);

    expect(reservation.status).toBe('COMMITTED');

    expect(
      await prisma.paymentEvent.count({
        where: { paymentId },
      }),
    ).toBe(1);
  });

  it('should process the same successful payment notification only once', async () => {
    // First IPN: payment should be confirmed.
    await confirm();

    // Second IPN: the same notification is delivered again.
    await expect(confirm()).resolves.toBeDefined();

    const updatedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    const updatedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    const updatedInventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId },
    });

    expect(updatedPayment.status).toBe('SUCCEEDED');
    expect(updatedOrder.status).toBe('CONFIRMED');

    // Inventory must be decremented only once.
    expect(updatedInventory.availableQuantity).toBe(4);
    expect(updatedInventory.reservedQuantity).toBe(0);

    // The same provider event must not be duplicated.
    expect(events).toHaveLength(1);
  });

  it('should handle concurrent duplicate payment notifications safely', async () => {
    // Simulate three simultaneous deliveries of the same IPN.
    const results = await Promise.allSettled([confirm(), confirm(), confirm()]);

    const rejected = results.filter((result) => result.status === 'rejected');

    expect(rejected).toHaveLength(0);

    const updatedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    const updatedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    const updatedInventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId },
    });

    expect(updatedPayment.status).toBe('SUCCEEDED');
    expect(updatedOrder.status).toBe('CONFIRMED');

    // Product quantity must change only once.
    expect(updatedInventory.availableQuantity).toBe(4);
    expect(updatedInventory.reservedQuantity).toBe(0);

    // One provider event for the same notification.
    expect(events).toHaveLength(1);
  });

  it('should fail payment and release inventory after provider confirms failure', async () => {
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    // Simulate the provider confirming that the transaction failed.
    const originalQuery = provider.queryTransaction;

    provider.queryTransaction = async (id: string) => ({
      status: 'FAILED',
      tran_id: id,
      amount: payment.amount.toFixed(2),
      currency_type: payment.currency,
    });

    try {
      await paymentsService.handleFailureNotification({
        tranId: tranId,
        ipnStatus: 'FAILED',
        payload: {
          tran_id: tranId,
          status: 'FAILED',
        },
      });
    } finally {
      provider.queryTransaction = originalQuery;
    }

    const updatedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    const updatedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    const updatedInventory = await prisma.inventory.findUniqueOrThrow({
      where: { productId },
    });

    const reservation = await prisma.inventoryReservation.findFirstOrThrow({
      where: { orderId },
    });

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId },
    });

    expect(updatedPayment.status).toBe('FAILED');
    expect(updatedOrder.status).toBe('CANCELLED');

    expect(updatedInventory.availableQuantity).toBe(5);
    expect(updatedInventory.reservedQuantity).toBe(0);

    expect(reservation.status).toBe('RELEASED');

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('PAYMENT_FAILED');
    expect(events[0].status).toBe('PROCESSED');
  });
});
