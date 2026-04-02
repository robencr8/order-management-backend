import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma'
import { createOrderEvent } from '../modules/orders/event.service'

type Tx = Prisma.TransactionClient

// Payment status values to match schema strings
type PaymentStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUNDED'

export interface CreatePaymentAttemptData {
  orderId: string
  provider: string
  amountMinor: number
  currency: string
  metadata?: Record<string, unknown>
}

export interface UpdatePaymentStatusData {
  paymentAttemptId: string
  status: PaymentStatus
  providerReference?: string
  failureReason?: string
  metadata?: Record<string, unknown>
}

export interface RefundPaymentData {
  paymentAttemptId: string
  refundAmountMinor: number
  reason: string
  metadata?: Record<string, unknown>
}

export class PaymentService {
  private static readonly PAYMENT_STATUS_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
    PENDING: ['PROCESSING', 'CANCELLED', 'FAILED'],
    PROCESSING: ['COMPLETED', 'FAILED', 'CANCELLED'],
    COMPLETED: ['REFUNDED'],
    FAILED: ['PENDING'],
    CANCELLED: ['PENDING'],
    REFUNDED: [],
  }

  private static isValidPaymentTransition(
    from: PaymentStatus,
    to: PaymentStatus
  ): boolean {
    return this.PAYMENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false
  }

  static async createPaymentAttempt(
    data: CreatePaymentAttemptData,
    actorUserId?: string
  ) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: data.orderId },
        select: {
          id: true,
          paymentAttempts: {
            where: {
              status: { in: ['PENDING', 'PROCESSING'] }
            },
            select: { id: true }
          }
        }
      })

      if (!order) throw new Error('Order not found')

      if (order.paymentAttempts.length > 0) {
        throw new Error('Active payment attempt exists')
      }

      const paymentAttempt = await tx.paymentAttempt.create({
        data: {
          orderId: data.orderId,
          provider: data.provider,
          amountMinor: data.amountMinor,
          currency: data.currency,
          status: 'PENDING',
          metadataJson: data.metadata ? JSON.stringify(data.metadata) : null,
        },
      })

      await createOrderEvent(tx, {
        orderId: data.orderId,
        eventType: 'payment_initiated',
        actorUserId: actorUserId ?? null,
        payload: {
          provider: data.provider,
          amountMinor: data.amountMinor,
          currency: data.currency,
        },
      })

      return paymentAttempt
    })
  }

  static async updatePaymentStatus(
    data: UpdatePaymentStatusData,
    actorUserId?: string
  ) {
    return prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.findUnique({
        where: { id: data.paymentAttemptId },
        select: {
          id: true,
          status: true,
          orderId: true,
          provider: true,
          amountMinor: true,
          currency: true,
          providerReference: true,
        }
      })

      if (!attempt) throw new Error('Payment attempt not found')

      if (attempt.status === data.status) return attempt

      if (!this.isValidPaymentTransition(attempt.status as PaymentStatus, data.status)) {
        throw new Error(`Invalid transition ${attempt.status} → ${data.status}`)
      }

      if (data.status === 'COMPLETED' && data.providerReference) {
        const exists = await tx.paymentAttempt.findFirst({
          where: {
            providerReference: data.providerReference,
            status: 'COMPLETED',
            NOT: { id: data.paymentAttemptId },
          },
          select: { id: true }
        })

        if (exists) {
          throw new Error('Duplicate providerReference (idempotency violation)')
        }
      }

      const updated = await tx.paymentAttempt.update({
        where: { id: data.paymentAttemptId },
        data: {
          status: data.status,
          providerReference: data.providerReference ?? attempt.providerReference,
          failureReason: data.failureReason ?? null,
          metadataJson: data.metadata ? JSON.stringify(data.metadata) : null,
        },
      })

      await createOrderEvent(tx, {
        orderId: attempt.orderId,
        eventType: this.getPaymentEventType(data.status),
        actorUserId: actorUserId ?? null,
        payload: {
          provider: attempt.provider,
          amountMinor: attempt.amountMinor,
          currency: attempt.currency,
          providerReference: data.providerReference,
          failureReason: data.failureReason,
        },
      })

      if (data.status === 'COMPLETED') {
        await this.handlePaymentCompletion(tx, attempt.orderId)
      }

      if (['FAILED', 'CANCELLED'].includes(data.status)) {
        await this.handlePaymentFailure(tx, attempt.orderId)
      }

      return updated
    })
  }

  static async refundPayment(
    data: RefundPaymentData,
    actorUserId?: string
  ) {
    return prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.findUnique({
        where: { id: data.paymentAttemptId },
        select: {
          id: true,
          status: true,
          amountMinor: true,
          orderId: true,
          metadataJson: true,
        }
      })

      if (!attempt) throw new Error('Payment attempt not found')

      if (attempt.status !== 'COMPLETED') {
        throw new Error('Refund only allowed for COMPLETED payments')
      }

      if (data.refundAmountMinor > attempt.amountMinor) {
        throw new Error('Refund exceeds original amount')
      }

      // Merge refund metadata with existing metadata
      const existingMetadata = attempt.metadataJson ? JSON.parse(attempt.metadataJson) : {}
      const updatedMetadata = {
        ...existingMetadata,
        refundAmountMinor: data.refundAmountMinor,
        reason: data.reason,
        refundedAt: new Date().toISOString(),
        ...(data.metadata || {}),
      }

      const updated = await tx.paymentAttempt.update({
        where: { id: data.paymentAttemptId },
        data: {
          status: 'REFUNDED',
          metadataJson: JSON.stringify(updatedMetadata),
        },
      })

      await tx.order.update({
        where: { id: attempt.orderId },
        data: { paymentStatus: 'REFUNDED' }
      })

      await createOrderEvent(tx, {
        orderId: attempt.orderId,
        eventType: 'payment_refunded',
        actorUserId: actorUserId ?? null,
        payload: {
          refundAmountMinor: data.refundAmountMinor,
          reason: data.reason,
        },
      })

      return updated
    })
  }

  private static getPaymentEventType(status: PaymentStatus): string {
    switch (status) {
      case 'PROCESSING':
        return 'payment_initiated'
      case 'COMPLETED':
        return 'payment_completed'
      case 'FAILED':
      case 'CANCELLED':
        return 'payment_failed'
      case 'REFUNDED':
        return 'payment_refunded'
      default:
        return 'payment_status_changed'
    }
  }

  private static async handlePaymentCompletion(
    tx: Tx,
    orderId: string
  ) {
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'PAID' }
    })

    const order = await tx.order.findUnique({ where: { id: orderId } })
    if (order && order.status === 'PENDING') {
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CONFIRMED' }
      })

      await createOrderEvent(tx, {
        orderId,
        eventType: 'status_changed',
        actorUserId: null,
        payload: {
          from: 'PENDING',
          to: 'CONFIRMED',
          reason: 'payment_completed',
        },
      })
    }
  }

  private static async handlePaymentFailure(
    tx: Tx,
    orderId: string
  ) {
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'FAILED' }
    })

    await createOrderEvent(tx, {
      orderId,
      eventType: 'payment_failed',
      actorUserId: null,
      payload: {
        timestamp: new Date().toISOString(),
      },
    })
  }

  static async getOrderPaymentAttempts(orderId: string) {
    return prisma.paymentAttempt.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        provider: true,
        providerReference: true,
        amountMinor: true,
        currency: true,
        status: true,
        paymentType: true,
        failureReason: true,
        metadataJson: true,
        createdAt: true,
        updatedAt: true,
      }
    })
  }

  static async getPaymentAttempt(paymentAttemptId: string) {
    return prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      select: {
        id: true,
        orderId: true,
        provider: true,
        providerReference: true,
        amountMinor: true,
        currency: true,
        status: true,
        paymentType: true,
        failureReason: true,
        metadataJson: true,
        createdAt: true,
        updatedAt: true,
        order: {
          select: {
            id: true,
            publicOrderNumber: true,
            status: true,
            paymentStatus: true,
          }
        }
      }
    })
  }
}
