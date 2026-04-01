import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma'
import { logger } from '../lib/logger'
import {
  OrderStatus,
  OrderTransitionError,
  isTerminalOrderStatus,
  isValidOrderTransition
} from '../modules/orders/transitions'

type OrderStatusType = typeof OrderStatus[keyof typeof OrderStatus]

export interface CreateOrderData {
  sellerId: string
  customerId: string
  items: Array<{
    productId: string
    quantity: number
  }>
  currency: string
  paymentType: string
  notes?: string
}

export interface UpdateOrderStatusData {
  orderId: string
  newStatus: OrderStatusType
  actorUserId: string
  reason?: string
}

export class OrderService {
  async createOrder(data: CreateOrderData) {
    logger.info('Creating order', { sellerId: data.sellerId, itemCount: data.items.length })

    return await prisma.$transaction(async (tx) => {
      // Generate unique order number
      const publicOrderNumber = await this.generateOrderNumber(tx, data.sellerId)

      // Calculate totals and validate products
      let subtotalMinor = 0
      const orderItems: Array<{
        productId: string
        productNameSnapshot: string
        unitPriceMinor: number
        quantity: number
        lineTotalMinor: number
      }> = []

      for (const item of data.items) {
        const product = await tx.product.findFirst({
          where: {
            id: item.productId,
            sellerId: data.sellerId,
            isActive: true
          }
        })

        if (!product) {
          throw new Error(`Product ${item.productId} not found or inactive`)
        }

        if (product.stockQuantity < item.quantity) {
          throw new Error(`Insufficient stock for product ${product.name}`)
        }

        const unitPriceMinor = product.priceMinor
        const lineTotalMinor = unitPriceMinor * item.quantity
        subtotalMinor += lineTotalMinor

        orderItems.push({
          productId: item.productId,
          productNameSnapshot: product.name,
          unitPriceMinor,
          quantity: item.quantity,
          lineTotalMinor
        })

        // Update stock
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stockQuantity: product.stockQuantity - item.quantity
          }
        })
      }

      // Create order
      const order = await tx.order.create({
        data: {
          sellerId: data.sellerId,
          customerId: data.customerId,
          publicOrderNumber,
          status: OrderStatus.PENDING,
          paymentType: data.paymentType,
          paymentStatus: 'PENDING',
          subtotalMinor,
          totalMinor: subtotalMinor, // Add delivery fee logic later
          currency: data.currency,
          source: 'public_api',
          notes: data.notes
        },
        include: {
          customer: true,
          orderItems: true
        }
      })

      // Create order items with proper orderId
      const orderItemsWithOrderId = orderItems.map(item => ({
        ...item,
        orderId: order.id
      }))
      await tx.orderItem.createMany({
        data: orderItemsWithOrderId
      })

      // Log order creation event
      await this.createOrderEvent(tx, {
        orderId: order.id,
        actorUserId: null, // System created
        eventType: 'ORDER_CREATED',
        payload: {
          publicOrderNumber,
          itemCount: orderItems.length,
          subtotalMinor,
          currency: data.currency
        }
      })

      logger.info('Order created successfully', {
        orderId: order.id,
        publicOrderNumber: order.publicOrderNumber
      })

      return order
    })
  }

  async updateOrderStatus(data: UpdateOrderStatusData) {
    const { orderId, newStatus, actorUserId, reason } = data

    logger.info('Updating order status', { orderId, newStatus, actorUserId })

    return await prisma.$transaction(async (tx) => {
      // Get current order
      const currentOrder = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          customer: true,
          orderItems: {
            include: { product: true }
          }
        }
      })

      if (!currentOrder) {
        throw new Error('Order not found')
      }

      // Validate transition
      if (!isValidOrderTransition(currentOrder.status, newStatus)) {
        throw new OrderTransitionError(currentOrder.status, newStatus)
      }

      // Business logic for specific transitions
      await this.validateTransitionRules(tx, currentOrder, newStatus, reason)

      // Update order status
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: { status: newStatus },
        include: {
          customer: true,
          orderItems: true
        }
      })

      // Log status change event
      await this.createOrderEvent(tx, {
        orderId,
        actorUserId,
        eventType: 'STATUS_CHANGED',
        payload: {
          from: currentOrder.status,
          to: newStatus,
          reason: reason || null,
          timestamp: new Date().toISOString()
        }
      })

      // Handle post-transition actions
      await this.handlePostTransitionActions(tx, updatedOrder, currentOrder.status, newStatus)

      logger.info('Order status updated successfully', {
        orderId,
        from: currentOrder.status,
        to: newStatus
      })

      return updatedOrder
    })
  }

  private async generateOrderNumber(tx: Prisma.TransactionClient, sellerId: string): Promise<string> {
    const prefix = 'ORD'
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')

    // Get count of orders today for this seller
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)

    const orderCount = await tx.order.count({
      where: {
        sellerId,
        createdAt: {
          gte: todayStart,
          lte: todayEnd
        }
      }
    })

    const sequence = (orderCount + 1).toString().padStart(3, '0')
    return `${prefix}-${date}-${sequence}`
  }

  private async validateTransitionRules(
    tx: Prisma.TransactionClient,
    order: any,
    newStatus: OrderStatus,
    reason?: string
  ) {
    // CANCELLATION rules
    if (newStatus === OrderStatus.CANCELLED) {
      if (isTerminalOrderStatus(order.status)) {
        throw new Error('Cannot cancel order in terminal state')
      }

      // Restock items
      for (const item of order.orderItems) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stockQuantity: {
              increment: item.quantity
            }
          }
        })
      }
    }

    // CONFIRMATION rules
    if (newStatus === OrderStatus.CONFIRMED) {
      if (order.status !== OrderStatus.PENDING) {
        throw new Error('Can only confirm pending orders')
      }

      // Validate stock again
      for (const item of order.orderItems) {
        const product = await tx.product.findUnique({
          where: { id: item.productId }
        })

        if (!product || product.stockQuantity < 0) {
          throw new Error(`Insufficient stock for ${item.productNameSnapshot}`)
        }
      }
    }
  }

  private async handlePostTransitionActions(
    tx: Prisma.TransactionClient,
    order: any,
    oldStatus: OrderStatus,
    newStatus: OrderStatus
  ) {
    // Auto-update payment status for delivered orders
    if (newStatus === OrderStatus.DELIVERED && order.paymentType === 'CASH_ON_DELIVERY') {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'PAID' }
      })

      await this.createOrderEvent(tx, {
        orderId: order.id,
        actorUserId: null,
        eventType: 'PAYMENT_COMPLETED',
        payload: {
          paymentType: order.paymentType,
          amountMinor: order.totalMinor,
          currency: order.currency
        }
      })
    }
  }

  private async createOrderEvent(
    tx: Prisma.TransactionClient,
    data: {
      orderId: string
      actorUserId: string | null
      eventType: string
      payload: any
    }
  ) {
    await tx.orderEvent.create({
      data: {
        orderId: data.orderId,
        actorUserId: data.actorUserId,
        eventType: data.eventType,
        payloadJson: JSON.stringify(data.payload)
      }
    })
  }

  async getOrderById(orderId: string, sellerId: string) {
    return await prisma.order.findFirst({
      where: {
        id: orderId,
        sellerId
      },
      include: {
        customer: true,
        orderItems: {
          include: { product: true }
        },
        events: {
          orderBy: { createdAt: 'desc' }
        }
      }
    })
  }

  async getOrders(sellerId: string, options: {
    status?: OrderStatus
    page?: number
    limit?: number
    startDate?: Date
    endDate?: Date
  } = {}) {
    const { status, page = 1, limit = 20, startDate, endDate } = options

    const where: Prisma.OrderWhereInput = {
      sellerId
    }

    if (status) where.status = status
    if (startDate || endDate) {
      where.createdAt = {}
      if (startDate) where.createdAt.gte = startDate
      if (endDate) where.createdAt.lte = endDate
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          customer: true,
          orderItems: true
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.order.count({ where })
    ])

    return {
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    }
  }
}

export const orderService = new OrderService()
