import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { logger } from '../../lib/logger'

export interface CreateOrderEventRequest {
  orderId: string
  eventType: string
  actorUserId?: string | null
  payload?: Record<string, unknown>
}

export interface OrderEvent {
  id: string
  orderId: string
  actorUserId: string | null
  eventType: string
  payloadJson: string | null
  createdAt: Date
}

export class EventService {
  async createOrderEvent(
    tx: Prisma.TransactionClient, // Transaction client
    request: CreateOrderEventRequest
  ): Promise<OrderEvent> {
    const { orderId, eventType, actorUserId, payload } = request

    logger.debug('Creating order event', { orderId, eventType, actorUserId })

    const event = await tx.orderEvent.create({
      data: {
        orderId,
        eventType,
        actorUserId,
        payloadJson: payload ? JSON.stringify(payload) : null,
      },
    })

    logger.debug('Order event created', { eventId: event.id, eventType })
    return event
  }

  async getOrderEvents(orderId: string): Promise<OrderEvent[]> {
    return prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async getOrderEventsByType(orderId: string, eventType: string): Promise<OrderEvent[]> {
    return prisma.orderEvent.findMany({
      where: {
        orderId,
        eventType,
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async getLatestOrderEvent(orderId: string): Promise<OrderEvent | null> {
    return prisma.orderEvent.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async createPaymentEvent(
    tx: Prisma.TransactionClient,
    orderId: string,
    eventType: 'payment_initiated' | 'payment_completed' | 'payment_failed',
    payload: {
      provider?: string
      amountMinor?: number
      reference?: string
      reason?: string
    },
    actorUserId?: string
  ): Promise<OrderEvent> {
    return this.createOrderEvent(tx, {
      orderId,
      eventType,
      actorUserId,
      payload,
    })
  }

  async createStatusChangeEvent(
    tx: Prisma.TransactionClient,
    orderId: string,
    fromStatus: string,
    toStatus: string,
    actorUserId?: string,
    notes?: string
  ): Promise<OrderEvent> {
    return this.createOrderEvent(tx, {
      orderId,
      eventType: 'status_changed',
      actorUserId,
      payload: {
        from: fromStatus,
        to: toStatus,
        notes,
        timestamp: new Date().toISOString(),
      },
    })
  }

  async createSystemEvent(
    tx: PrismaClient,
    orderId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<OrderEvent> {
    return this.createOrderEvent(tx, {
      orderId,
      eventType,
      payload,
    })
  }
}

export const eventService = new EventService()

// Export the transaction function for use in services
export const createOrderEvent = eventService.createOrderEvent.bind(eventService)
