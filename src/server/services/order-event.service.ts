import { Prisma, PrismaClient } from '@prisma/client'
import { logger } from '../lib/logger'

export interface OrderEventData {
  orderId: string
  actorUserId: string | null
  eventType: string
  payload?: Record<string, any>
}

export class OrderEventService {
  /**
   * Create an order event within a transaction
   * This should be called from within any Prisma transaction that modifies order data
   */
  static async createEvent(
    tx: Prisma.TransactionClient,
    data: OrderEventData
  ): Promise<void> {
    try {
      await tx.orderEvent.create({
        data: {
          orderId: data.orderId,
          actorUserId: data.actorUserId,
          eventType: data.eventType,
          payloadJson: data.payload ? JSON.stringify(data.payload) : null,
        },
      })

      logger.info('Order event created', {
        orderId: data.orderId,
        eventType: data.eventType,
        actorUserId: data.actorUserId,
      })
    } catch (error) {
      logger.error('Failed to create order event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        orderId: data.orderId,
        eventType: data.eventType,
      })
      throw new Error(`Failed to create order event: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Create multiple order events within a transaction
   * Useful for complex operations that need multiple events
   */
  static async createEvents(
    tx: Prisma.TransactionClient,
    events: OrderEventData[]
  ): Promise<void> {
    for (const event of events) {
      await this.createEvent(tx, event)
    }
  }

  /**
   * Standard event types for consistency
   */
  static readonly EVENT_TYPES = {
    // Order lifecycle
    ORDER_CREATED: 'ORDER_CREATED',
    ORDER_CONFIRMED: 'ORDER_CONFIRMED',
    ORDER_CANCELLED: 'ORDER_CANCELLED',
    ORDER_PACKED: 'ORDER_PACKED',
    ORDER_OUT_FOR_DELIVERY: 'ORDER_OUT_FOR_DELIVERY',
    ORDER_DELIVERED: 'ORDER_DELIVERED',

    // Payment events
    PAYMENT_INITIATED: 'PAYMENT_INITIATED',
    PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
    PAYMENT_PARTIALLY_REFUNDED: 'PAYMENT_PARTIALLY_REFUNDED',

    // Stock events
    STOCK_RESERVED: 'STOCK_RESERVED',
    STOCK_RELEASED: 'STOCK_RELEASED',
    STOCK_ADJUSTED: 'STOCK_ADJUSTED',

    // Notification events
    NOTIFICATION_QUEUED: 'NOTIFICATION_QUEUED',
    NOTIFICATION_SENT: 'NOTIFICATION_SENT',
    NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',

    // System events
    STATUS_CHANGED: 'STATUS_CHANGED',
    ORDER_UPDATED: 'ORDER_UPDATED',
    ORDER_ASSIGNED: 'ORDER_ASSIGNED',
  } as const

  /**
   * Helper method to create standard status change event
   */
  static async createStatusChangeEvent(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorUserId: string | null,
    fromStatus: string,
    toStatus: string,
    reason?: string
  ): Promise<void> {
    await this.createEvent(tx, {
      orderId,
      actorUserId,
      eventType: this.EVENT_TYPES.STATUS_CHANGED,
      payload: {
        from: fromStatus,
        to: toStatus,
        reason: reason || null,
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Helper method to create payment event
   */
  static async createPaymentEvent(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorUserId: string | null,
    eventType: string,
    paymentData: {
      provider: string
      amountMinor: number
      currency: string
      providerReference?: string
      failureReason?: string
    }
  ): Promise<void> {
    // Prevent duplicate payment events
    const existingEvent = await tx.orderEvent.findFirst({
      where: {
        orderId,
        eventType,
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    // For payment events, check if we already have this event type for this payment
    if (existingEvent && eventType.startsWith('PAYMENT_')) {
      const existingPayload = existingEvent.payloadJson ? JSON.parse(existingEvent.payloadJson) : {}

      // If same providerReference exists, this is a duplicate
      if (paymentData.providerReference && existingPayload.providerReference === paymentData.providerReference) {
        return // Skip duplicate
      }

      // For terminal events (COMPLETED, FAILED, CANCELLED), don't allow duplicates
      if (['PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED'].includes(eventType)) {
        return // Skip duplicate terminal event
      }
    }

    await this.createEvent(tx, {
      orderId,
      actorUserId,
      eventType,
      payload: {
        ...paymentData,
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Helper method to create stock event
   */
  static async createStockEvent(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorUserId: string | null,
    eventType: string,
    stockData: {
      productId: string
      productName: string
      quantity: number
      reason?: string
    }
  ): Promise<void> {
    await this.createEvent(tx, {
      orderId,
      actorUserId,
      eventType,
      payload: {
        ...stockData,
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Get order events for debugging/audit
   */
  static async getOrderEvents(
    prisma: PrismaClient,
    orderId: string,
    options?: {
      limit?: number
      offset?: number
      eventTypes?: string[]
    }
  ) {
    const { limit = 100, offset = 0, eventTypes } = options || {}

    const where: Prisma.OrderEventWhereInput = { orderId }
    if (eventTypes && eventTypes.length > 0) {
      where.eventType = { in: eventTypes }
    }

    return await prisma.orderEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        order: {
          select: {
            publicOrderNumber: true,
            sellerId: true,
          },
        },
      },
    })
  }

  /**
   * Get event timeline for order
   */
  static async getOrderTimeline(
    prisma: PrismaClient,
    orderId: string
  ) {
    const events = await this.getOrderEvents(prisma, orderId, {
      limit: 50, // Reasonable limit for timeline
    })

    return events.map(event => ({
      id: event.id,
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      payload: event.payloadJson ? JSON.parse(event.payloadJson) : null,
      createdAt: event.createdAt,
    }))
  }
}
