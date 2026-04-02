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
      slug: `test-widget-${ts}`,
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
  test('payment completing on a PENDING order moves to CONFIRMED with correct events', async () => {
    const { order } = await seedPendingOrder()

    // Count events before payment
    const eventsBefore = await prisma.orderEvent.findMany({ where: { orderId: order.id } })
    const statusChangeCountBefore = eventsBefore.filter(e => e.eventType === 'STATUS_CHANGED').length

    const attempt = await PaymentService.createPaymentAttempt({
      orderId: order.id,
      provider: 'STRIPE',
      amountMinor: 1000,
      currency: 'USD',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'PROCESSING',
      providerReference: 'pi_basic_test',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'COMPLETED',
      providerReference: 'pi_basic_test',
    })

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(updated.status).toBe('CONFIRMED')
    expect(updated.paymentStatus).toBe('PAID')

    // Verify payment attempt is completed
    const payment = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } })
    expect(payment?.status).toBe('COMPLETED')

    // Verify event integrity
    const eventsAfter = await prisma.orderEvent.findMany({ where: { orderId: order.id } })
    const statusChangeCountAfter = eventsAfter.filter(e => e.eventType === 'STATUS_CHANGED').length

    // Should have exactly one more STATUS_CHANGED event (PENDING -> CONFIRMED)
    expect(statusChangeCountAfter).toBe(statusChangeCountBefore + 1)

    // Verify correct payment events exist
    const paymentEvents = eventsAfter.filter(e => e.eventType.startsWith('PAYMENT_'))
    const paymentEventTypes = paymentEvents.map(e => e.eventType)
    expect(paymentEventTypes).toContain('PAYMENT_INITIATED')
    expect(paymentEventTypes).toContain('PAYMENT_CONFIRMED')

    // Verify the status change event is correct
    const statusChangeEvents = eventsAfter.filter(e => e.eventType === 'STATUS_CHANGED')
    const latestStatusChange = statusChangeEvents[statusChangeEvents.length - 1]
    if (latestStatusChange?.payloadJson) {
      const payload = JSON.parse(latestStatusChange.payloadJson)
      expect(payload.from).toBe('PENDING')
      expect(payload.to).toBe('CONFIRMED')
    }
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

  test('duplicate payment initiation does not create duplicate events', async () => {
    const { order } = await seedPendingOrder()

    const attempt = await PaymentService.createPaymentAttempt({
      orderId: order.id,
      provider: 'STRIPE',
      amountMinor: 1000,
      currency: 'USD',
    })

    // Call PROCESSING twice - should only create one PAYMENT_INITIATED event with providerReference
    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'PROCESSING',
      providerReference: 'pi_duplicate_test',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'PROCESSING',
      providerReference: 'pi_duplicate_test',
    })

    // Assert only one PAYMENT_INITIATED event with providerReference exists
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } })
    const paymentInitiatedEvents = events.filter(e =>
      e.eventType === 'PAYMENT_INITIATED' &&
      e.payloadJson?.includes('pi_duplicate_test')
    )
    expect(paymentInitiatedEvents).toHaveLength(1)
  })

  test('duplicate COMPLETED does not duplicate side effects', async () => {
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
      providerReference: 'pi_completed_duplicate_test',
    })

    // Complete payment twice
    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'COMPLETED',
      providerReference: 'pi_completed_duplicate_test',
    })

    await PaymentService.updatePaymentStatus({
      paymentAttemptId: attempt.id,
      status: 'COMPLETED',
      providerReference: 'pi_completed_duplicate_test',
    })

    // Assert only one PAYMENT_CONFIRMED event exists
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } })
    const paymentConfirmedEvents = events.filter(e => e.eventType === 'PAYMENT_CONFIRMED')
    expect(paymentConfirmedEvents).toHaveLength(1)

    // Assert order unchanged (still CONFIRMED, not double-processed)
    const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } })
    expect(updatedOrder?.status).toBe('CONFIRMED')
    expect(updatedOrder?.paymentStatus).toBe('PAID')
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
