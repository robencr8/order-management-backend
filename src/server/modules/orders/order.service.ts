import { prisma } from '../../db/prisma'
import { logger } from '../../lib/logger'
import { createOrderEvent } from './event.service'
import { ApiError } from '../../lib/errors'

export interface CreateOrderRequest {
  sellerId: string
  customerId: string
  items: Array<{
    productId: string
    quantity: number
  }>
  deliveryFeeMinor?: number
  notes?: string
}

export interface OrderTransitionRequest {
  orderId: string
  newStatus: string
  actorUserId?: string
  notes?: string
}

export interface Order {
  id: string
  sellerId: string
  customerId: string
  publicOrderNumber: string
  status: string
  paymentStatus: string
  subtotalMinor: number
  deliveryFeeMinor: number
  totalMinor: number
  currency: string
  notes?: string
  source: string
  createdAt: Date
  updatedAt: Date
}

export interface OrderItem {
  id: string
  orderId: string
  productId: string
  productNameSnapshot: string
  unitPriceMinor: number
  quantity: number
  lineTotalMinor: number
}

// Order state machine - defines valid transitions
const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [], // Terminal state
  RETURNED: [], // Terminal state
}

export class OrderService {
  async createOrder(request: CreateOrderRequest, actorUserId?: string): Promise<Order> {
    const { sellerId, customerId, items, deliveryFeeMinor = 0, notes } = request

    logger.info('Creating order', { sellerId, customerId, itemCount: items.length })

    // Validate seller exists
    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
    })

    if (!seller) {
      throw new ApiError(404, 'Seller not found')
    }

    // Validate customer exists and belongs to seller
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    })

    if (!customer || customer.sellerId !== sellerId) {
      throw new ApiError(404, 'Customer not found')
    }

    // Validate products and calculate totals
    const productIds = items.map(item => item.productId)
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        sellerId,
        isActive: true,
      },
    })

    if (products.length !== items.length) {
      throw new ApiError(400, 'Some products are invalid or unavailable')
    }

    // Check stock availability
    for (const item of items) {
      const product = products.find(p => p.id === item.productId)!
      if (product.stockQuantity < item.quantity) {
        throw new ApiError(400, `Insufficient stock for product: ${product.name}`)
      }
    }

    // Calculate order totals
    const orderItems = items.map(item => {
      const product = products.find(p => p.id === item.productId)!
      const lineTotalMinor = product.priceMinor * item.quantity
      
      return {
        productId: item.productId,
        productNameSnapshot: product.name,
        unitPriceMinor: product.priceMinor,
        quantity: item.quantity,
        lineTotalMinor,
      }
    })

    const subtotalMinor = orderItems.reduce((sum, item) => sum + item.lineTotalMinor, 0)
    const totalMinor = subtotalMinor + deliveryFeeMinor

    // Create order in a transaction
    const order = await prisma.$transaction(async (tx) => {
      // Create order
      const newOrder = await tx.order.create({
        data: {
          sellerId,
          customerId,
          publicOrderNumber: this.generatePublicOrderNumber(),
          subtotalMinor,
          deliveryFeeMinor,
          totalMinor,
          currency: seller.currency,
          notes,
          source: 'seller_api',
          status: 'PENDING',
          paymentStatus: 'PENDING',
        },
      })

      // Create order items
      await tx.orderItem.createMany({
        data: orderItems.map(item => ({
          orderId: newOrder.id,
          productId: item.productId,
          productNameSnapshot: item.productNameSnapshot,
          unitPriceMinor: item.unitPriceMinor,
          quantity: item.quantity,
          lineTotalMinor: item.lineTotalMinor,
        })),
      })

      // Update product stock
      for (const item of items) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stockQuantity: {
              decrement: item.quantity,
            },
          },
        })
      }

      // Create order event
      await createOrderEvent(tx, {
        orderId: newOrder.id,
        eventType: 'order_created',
        actorUserId,
        payload: {
          source: 'seller_api',
          itemCount: items.length,
          totalMinor,
        },
      })

      return newOrder
    })

    logger.info('Order created successfully', { 
      orderId: order.id, 
      publicOrderNumber: order.publicOrderNumber,
      totalMinor: order.totalMinor 
    })

    return order
  }

  async applyTransition(request: OrderTransitionRequest): Promise<Order> {
    const { orderId, newStatus, actorUserId, notes } = request

    logger.info('Applying order transition', { orderId, newStatus, actorUserId })

    // Get current order
    const currentOrder = await prisma.order.findUnique({
      where: { id: orderId },
    })

    if (!currentOrder) {
      throw new ApiError(404, 'Order not found')
    }

    // Validate transition
    const validTransitions = ORDER_STATUS_TRANSITIONS[currentOrder.status] || []
    if (!validTransitions.includes(newStatus)) {
      throw new ApiError(400, `Invalid status transition from ${currentOrder.status} to ${newStatus}`)
    }

    // Apply transition in transaction
    const updatedOrder = await prisma.$transaction(async (tx) => {
      // Update order status
      const order = await tx.order.update({
        where: { id: orderId },
        data: {
          status: newStatus,
          updatedAt: new Date(),
        },
      })

      // Create order event
      await createOrderEvent(tx, {
        orderId,
        eventType: 'status_changed',
        actorUserId,
        payload: {
          from: currentOrder.status,
          to: newStatus,
          notes,
        },
      })

      return order
    })

    logger.info('Order transition applied', { 
      orderId, 
      from: currentOrder.status, 
      to: newStatus 
    })

    return updatedOrder
  }

  async cancelOrder(orderId: string, actorUserId?: string, reason?: string): Promise<Order> {
    logger.info('Cancelling order', { orderId, actorUserId, reason })

    return this.applyTransition({
      orderId,
      newStatus: 'CANCELLED',
      actorUserId,
      notes: reason,
    })
  }

  async getOrderById(orderId: string, sellerId?: string): Promise<Order | null> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        orderItems: {
          include: {
            product: true,
          },
        },
        customer: true,
        events: {
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    // If sellerId is provided, ensure order belongs to seller
    if (sellerId && order?.sellerId !== sellerId) {
      return null
    }

    return order
  }

  async getOrdersBySeller(sellerId: string, options?: {
    status?: string
    limit?: number
    offset?: number
  }): Promise<Order[]> {
    const { status, limit = 50, offset = 0 } = options || {}

    return prisma.order.findMany({
      where: {
        sellerId,
        ...(status && { status }),
      },
      include: {
        orderItems: true,
        customer: true,
        events: {
          orderBy: { createdAt: 'desc' },
          take: 1, // Only latest event for list view
        },
      },
      orderBy: { createdAt: 'desc' },
      limit,
      offset,
    })
  }

  private generatePublicOrderNumber(): string {
    const timestamp = Date.now().toString(36).toUpperCase()
    const random = Math.random().toString(36).substring(2, 6).toUpperCase()
    return `ORD-${timestamp}-${random}`
  }
}

export const orderService = new OrderService()
