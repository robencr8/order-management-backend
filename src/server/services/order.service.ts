import { Order, OrderItem, Prisma } from '@prisma/client'
import { prisma } from '../db/prisma'
import { logger } from '../lib/logger'
import { createOrderEvent } from '../modules/orders/event.service'
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

        // Update stock with proper concurrency handling
        const stockUpdate = await tx.product.update({
          where: { id: item.productId },
          data: {
            stockQuantity: { decrement: item.quantity }
          }
        })

        // Verify stock was sufficient (handles race condition)
        if (stockUpdate.stockQuantity < 0) {
          throw new Error(`Insufficient stock for product ${product.name}. Available: ${product.stockQuantity}, Requested: ${item.quantity}`)
        }
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

      // Log order creation event using centralized service
      await createOrderEvent(tx, {
        orderId: order.id,
        actorUserId: null, // System created
        eventType: 'order_created',
        payload: {
          publicOrderNumber,
          itemCount: orderItems.length,
          subtotalMinor,
          currency: data.currency,
          paymentType: data.paymentType,
        },
      })

      logger.info('Order created successfully', {
        orderId: order.id,
        publicOrderNumber: order.publicOrderNumber
      })

      return order
    })
  }

  /**
   * Applies an order status transition within an existing transaction.
   * This is the single authoritative path for all order status changes —
   * validates via the state machine, updates the row, and emits the event.
   * Use this from payment or any other service that needs to drive an
   * order transition inside its own transaction.
   */
  static async applyTransitionInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    newStatus: OrderStatusType,
    actorUserId: string | null,
    reason?: string
  ): Promise<void> {
    const order = await tx.order.findUnique({ where: { id: orderId } })
    if (!order) throw new Error('Order not found')
    const currentStatus = order.status as OrderStatusType
    if (!isValidOrderTransition(currentStatus, newStatus)) {
      throw new OrderTransitionError(currentStatus, newStatus)
    }
    await tx.order.update({ where: { id: orderId }, data: { status: newStatus } })
    await createOrderEvent(tx, {
      orderId,
      eventType: 'status_changed',
      actorUserId,
      payload: {
        from: currentStatus,
        to: newStatus,
        reason,
        timestamp: new Date().toISOString(),
      },
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
      if (!isValidOrderTransition(currentOrder.status as OrderStatus, newStatus)) {
        throw new OrderTransitionError(currentOrder.status as OrderStatus, newStatus)
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

      // Log status change event using centralized service
      await createOrderEvent(
        tx,
        {
          orderId,
          eventType: 'status_changed',
          actorUserId,
          payload: {
            from: currentOrder.status,
            to: newStatus,
            reason: data.reason,
            timestamp: new Date().toISOString(),
          },
        }
      )

      // Handle post-transition actions
      await this.handlePostTransitionActions(tx, updatedOrder, currentOrder.status as OrderStatus, newStatus)

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
    const orderNumber = `${prefix}-${date}-${sequence}`

    // Add timestamp to ensure uniqueness under concurrency
    const timestamp = Date.now().toString(36)
    return `${orderNumber}-${timestamp}`
  }

  private async validateTransitionRules(
    tx: Prisma.TransactionClient,
    order: Order & { orderItems: OrderItem[] },
    newStatus: OrderStatus,
    _reason?: string
  ) {
    // CANCELLATION rules
    if (newStatus === OrderStatus.CANCELLED) {
      if (isTerminalOrderStatus(order.status as OrderStatus)) {
        throw new Error('Cannot cancel order in terminal state')
      }

      // Restock items and log stock events
      for (const item of order.orderItems) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stockQuantity: {
              increment: item.quantity
            }
          }
        })

        // Log stock release event
        await createOrderEvent(tx, {
          orderId: order.id,
          eventType: 'stock_released',
          actorUserId: null,
          payload: {
            productId: item.productId,
            productName: item.productNameSnapshot,
            quantity: item.quantity,
            reason: 'order_cancelled',
          },
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
    order: Order & { orderItems: OrderItem[] },
    oldStatus: OrderStatus,
    newStatus: OrderStatus
  ) {
    // Auto-update payment status for delivered orders
    if (newStatus === OrderStatus.DELIVERED && order.paymentType === 'CASH_ON_DELIVERY') {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'PAID' }
      })

      // Log payment completion event
      await createOrderEvent(tx, {
        orderId: order.id,
        eventType: 'payment_completed',
        actorUserId: null,
        payload: {
          provider: 'CASH_ON_DELIVERY',
          amountMinor: order.totalMinor,
          currency: order.currency,
        },
      })
    }
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
