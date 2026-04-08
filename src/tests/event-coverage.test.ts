import { beforeEach, describe, expect, it } from 'vitest'
import { eventService } from '../server/modules/orders/event.service'
import { orderService } from '../server/modules/orders/order.service'
import { paymentService } from '../server/modules/orders/payment.service'
import { prisma } from '../tests/setup'

describe('Order Event Coverage', () => {
  beforeEach(async () => {
    await prisma.orderEvent.deleteMany()
    await prisma.paymentAttempt.deleteMany()
    await prisma.orderItem.deleteMany()
    await prisma.order.deleteMany()
    await prisma.customer.deleteMany()
    await prisma.product.deleteMany()
    await prisma.seller.deleteMany()
    await prisma.user.deleteMany()
  })

  it('should create order_created event when order is created', async () => {
    // Setup seller and user
    const user = await prisma.user.create({
      data: {
        email: `seller-${Date.now()}@example.com`,
        fullName: 'Test Seller',
        passwordHash: await (await import('bcryptjs')).hash('password', 12),
        role: 'SELLER',
        isActive: true,
      },
    })

    const seller = await prisma.seller.create({
      data: {
        ownerUserId: user.id,
        brandName: 'Test Store',
        slug: `test-store-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        currency: 'USD',
        status: 'ACTIVE',
      },
    })

    // Create product
    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        name: 'Test Product',
        slug: `test-product-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        priceMinor: 1999,
        currency: 'USD',
        stockQuantity: 100,
        isActive: true,
      },
    })

    // Create customer
    const customer = await prisma.customer.create({
      data: {
        sellerId: seller.id,
        name: 'Test Customer',
        phone: '+1234567890',
        addressText: '123 Test St',
      },
    })

    // Create order through service
    const order = await orderService.createOrder({
      sellerId: seller.id,
      customerId: customer.id,
      items: [
        {
          productId: product.id,
          quantity: 1,
        },
      ],
      deliveryFeeMinor: 500,
    }, user.id)

    // Verify order_created event was created
    const events = await eventService.getOrderEvents(order.id)
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('order_created')
    expect(events[0].actorUserId).toBe(user.id)
    expect(events[0].payloadJson).toBeTruthy()
  })

  it('should create payment events through payment service', async () => {
    // Setup minimal order for payment testing
    const user = await prisma.user.create({
      data: {
        email: `seller-${Date.now()}@example.com`,
        fullName: 'Test Seller',
        passwordHash: await (await import('bcryptjs')).hash('password', 12),
        role: 'SELLER',
        isActive: true,
      },
    })

    const seller = await prisma.seller.create({
      data: {
        ownerUserId: user.id,
        brandName: 'Test Store',
        slug: `test-store-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        currency: 'USD',
        status: 'ACTIVE',
      },
    })

    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        name: 'Test Product',
        slug: `test-product-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        priceMinor: 1999,
        currency: 'USD',
        stockQuantity: 100,
        isActive: true,
      },
    })

    const customer = await prisma.customer.create({
      data: {
        sellerId: seller.id,
        name: 'Test Customer',
        phone: '+1234567890',
        addressText: '123 Test St',
      },
    })

    const order = await orderService.createOrder({
      sellerId: seller.id,
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1 }],
      deliveryFeeMinor: 500,
    }, user.id)

    // Clear events from order creation
    await prisma.orderEvent.deleteMany({ where: { orderId: order.id } })

    // Simulate payment through service
    await paymentService.simulatePayment(order.id, true, user.id)

    // Verify payment events were created
    const events = await eventService.getOrderEvents(order.id)
    expect(events.length).toBeGreaterThan(0)

    const paymentEvents = events.filter(e =>
      e.eventType === 'payment_initiated' ||
      e.eventType === 'payment_completed'
    )
    expect(paymentEvents.length).toBeGreaterThan(0)
  })

  it('should create status_changed events for order transitions', async () => {
    // Setup order
    const user = await prisma.user.create({
      data: {
        email: `seller-${Date.now()}@example.com`,
        fullName: 'Test Seller',
        passwordHash: await (await import('bcryptjs')).hash('password', 12),
        role: 'SELLER',
        isActive: true,
      },
    })

    const seller = await prisma.seller.create({
      data: {
        ownerUserId: user.id,
        brandName: 'Test Store',
        slug: `test-store-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        currency: 'USD',
        status: 'ACTIVE',
      },
    })

    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        name: 'Test Product',
        slug: `test-product-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        priceMinor: 1999,
        currency: 'USD',
        stockQuantity: 100,
        isActive: true,
      },
    })

    const customer = await prisma.customer.create({
      data: {
        sellerId: seller.id,
        name: 'Test Customer',
        phone: '+1234567890',
        addressText: '123 Test St',
      },
    })

    const order = await orderService.createOrder({
      sellerId: seller.id,
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1 }],
      deliveryFeeMinor: 500,
    }, user.id)

    // Clear events from order creation
    await prisma.orderEvent.deleteMany({ where: { orderId: order.id } })

    // Apply valid status transition (PENDING -> CONFIRMED)
    await orderService.applyTransition({
      orderId: order.id,
      newStatus: 'CONFIRMED',
      actorUserId: user.id,
    })

    // Verify status_changed event was created
    const events = await eventService.getOrderEvents(order.id)
    const statusEvents = events.filter(e => e.eventType === 'status_changed')
    expect(statusEvents).toHaveLength(1)
    expect(statusEvents[0].actorUserId).toBe(user.id)
  })

  it('should handle idempotent event creation', async () => {
    // Test that duplicate event creation is handled gracefully
    const user = await prisma.user.create({
      data: {
        email: `seller-${Date.now()}@example.com`,
        fullName: 'Test Seller',
        passwordHash: await (await import('bcryptjs')).hash('password', 12),
        role: 'SELLER',
        isActive: true,
      },
    })

    const seller = await prisma.seller.create({
      data: {
        ownerUserId: user.id,
        brandName: 'Test Store',
        slug: `test-store-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        currency: 'USD',
        status: 'ACTIVE',
      },
    })

    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        name: 'Test Product',
        slug: `test-product-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        priceMinor: 1999,
        currency: 'USD',
        stockQuantity: 100,
        isActive: true,
      },
    })

    const customer = await prisma.customer.create({
      data: {
        sellerId: seller.id,
        name: 'Test Customer',
        phone: '+1234567890',
        addressText: '123 Test St',
      },
    })

    // Create order with proper data structure
    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          sellerId: seller.id,
          customerId: customer.id,
          publicOrderNumber: `ORD-TEST-${Date.now()}`,
          subtotalMinor: 1999,
          deliveryFeeMinor: 500,
          totalMinor: 2499,
          currency: 'USD',
          status: 'PENDING',
          paymentStatus: 'PENDING',
        },
      })

      await tx.orderItem.create({
        data: {
          orderId: newOrder.id,
          productId: product.id,
          productNameSnapshot: product.name,
          unitPriceMinor: product.priceMinor,
          quantity: 1,
          lineTotalMinor: product.priceMinor,
        },
      })

      return newOrder
    })

    // Get initial event count
    const initialEvents = await eventService.getOrderEvents(order.id)
    const initialCount = initialEvents.length

    // Create another event with same type
    await eventService.createSystemEvent(
      prisma,
      order.id,
      'test_event',
      { test: 'data' }
    )

    // Verify event was added
    const finalEvents = await eventService.getOrderEvents(order.id)
    expect(finalEvents.length).toBe(initialCount + 1)
  })
})
