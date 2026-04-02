import { prisma } from '../../server/db/prisma'
import { hashPassword } from '../../server/lib/auth'
import { orderService } from '../../server/services/order.service'
import { PaymentService } from '../../server/services/payment.service'

/**
 * Seeds the minimum data needed for an order: user, seller, product, customer.
 * Returns the created order in PENDING state.
 */
async function seedPendingOrder() {
  const ts = Date.now()

  const user = await prisma.user.create({
    data: {
      email: `seller-${ts}@test.com`,
      fullName: 'Test Seller',
      passwordHash: await hashPassword('password'),
      role: 'SELLER',
      isActive: true,
    },
  })

  const seller = await prisma.seller.create({
    data: {
      ownerUserId: user.id,
      brandName: 'Test Brand',
      slug: `brand-${ts}`,
      currency: 'USD',
      status: 'ACTIVE',
    },
  })

  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      name: 'Test Widget',
      slug: 'test-widget',
      priceMinor: 1000,
      currency: 'USD',
      stockQuantity: 10,
      isActive: true,
    },
  })

  const customer = await prisma.customer.create({
    data: {
      sellerId: seller.id,
      name: 'Test Customer',
      phone: `+1555${ts}`,
    },
  })

  const order = await orderService.createOrder({
    sellerId: seller.id,
    customerId: customer.id,
    items: [{ productId: product.id, quantity: 1 }],
    currency: 'USD',
    paymentType: 'STRIPE',
  })

  return { order, seller }
}

describe('Payment completion — order state integrity', () => {
  test('payment completing on a PENDING order confirms it', async () => {
    const { order } = await seedPendingOrder()

    const attempt = await PaymentService.createPaymentAttempt({
      orderId: order.id,
      provider: 'STRIPE',
      amountMinor: 1000,
      currency: 'USD',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'PROCESSING',
      providerReference: 'pi_pending_test',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'COMPLETED',
      providerReference: 'pi_pending_test',
    })

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(updated.status).toBe('CONFIRMED')
    expect(updated.paymentStatus).toBe('PAID')
  })

  test('payment completing on an already-PACKED order does not regress status', async () => {
    const { order } = await seedPendingOrder()

    // Advance order through the state machine to PACKED
    await orderService.updateOrderStatus({ orderId: order.id, newStatus: 'CONFIRMED', actorUserId: 'system' })
    await orderService.updateOrderStatus({ orderId: order.id, newStatus: 'PACKED', actorUserId: 'system' })

    const attempt = await PaymentService.createPaymentAttempt({
      orderId: order.id,
      provider: 'STRIPE',
      amountMinor: 1000,
      currency: 'USD',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'PROCESSING',
      providerReference: 'pi_packed_test',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'COMPLETED',
      providerReference: 'pi_packed_test',
    })

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    // Must not have regressed from PACKED to CONFIRMED
    expect(updated.status).toBe('PACKED')
    // Payment must still be recorded as paid
    expect(updated.paymentStatus).toBe('PAID')
  })

  test('payment completing on an OUT_FOR_DELIVERY order does not regress status', async () => {
    const { order } = await seedPendingOrder()

    await orderService.updateOrderStatus({ orderId: order.id, newStatus: 'CONFIRMED', actorUserId: 'system' })
    await orderService.updateOrderStatus({ orderId: order.id, newStatus: 'PACKED', actorUserId: 'system' })
    await orderService.updateOrderStatus({ orderId: order.id, newStatus: 'OUT_FOR_DELIVERY', actorUserId: 'system' })

    const attempt = await PaymentService.createPaymentAttempt({
      orderId: order.id,
      provider: 'STRIPE',
      amountMinor: 1000,
      currency: 'USD',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'PROCESSING',
      providerReference: 'pi_ofd_test',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'COMPLETED',
      providerReference: 'pi_ofd_test',
    })

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(updated.status).toBe('OUT_FOR_DELIVERY')
    expect(updated.paymentStatus).toBe('PAID')
  })
})
