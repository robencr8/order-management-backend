import { beforeEach, describe, expect, it } from 'vitest'
import { generatePublicOrderNumber } from '../server/lib/utils'
import { prisma } from './setup'

describe('Order Creation', () => {
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

  it('should create an order with items', async () => {
    // Create seller
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
        slug: 'test-store',
        currency: 'USD',
        status: 'ACTIVE',
      },
    })

    // Create product
    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        name: 'Test Product',
        slug: 'test-product',
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

    // Create order
    const order = await prisma.order.create({
      data: {
        sellerId: seller.id,
        customerId: customer.id,
        publicOrderNumber: generatePublicOrderNumber(),
        subtotalMinor: 1999,
        deliveryFeeMinor: 500,
        totalMinor: 2499,
        currency: 'USD',
        status: 'PENDING',
        paymentStatus: 'PENDING',
      },
    })

    // Create order item
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        productNameSnapshot: product.name,
        unitPriceMinor: product.priceMinor,
        quantity: 1,
        lineTotalMinor: product.priceMinor,
      },
    })

    // Create order event
    const orderEvent = await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: 'order_created',
        payloadJson: JSON.stringify({ source: 'test' }),
      },
    })

    expect(order.id).toBeDefined()
    expect(order.publicOrderNumber).toMatch(/^ORD-[A-Z0-9_-]{8,9}$/)
    expect(order.totalMinor).toBe(2499)
    expect(orderItem.quantity).toBe(1)
    expect(orderItem.lineTotalMinor).toBe(1999)
    expect(orderEvent.eventType).toBe('order_created')
  })

  it('should generate unique order numbers', async () => {
    const orderNumbers = new Set<string>()

    for (let i = 0; i < 100; i++) {
      const orderNumber = generatePublicOrderNumber()
      expect(orderNumbers.has(orderNumber)).toBe(false)
      orderNumbers.add(orderNumber)
      expect(orderNumber).toMatch(/^ORD-[A-Z0-9_-]{8,9}$/)
    }
  })
})
