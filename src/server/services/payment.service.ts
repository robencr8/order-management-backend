import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma'
import { logger } from '../lib/logger'
import { OrderEventService } from './order-event.service'

export interface CreatePaymentAttemptData {
  orderId: string
  provider: string
  amountMinor: number
  currency: string
  metadata?: Record<string, unknown>
}

export interface UpdatePaymentStatusData {
  paymentAttemptId: string
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUNDED'
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
  /**
   * Payment status transitions following business rules
   */
  private static readonly PAYMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
    'PENDING': ['PROCESSING', 'CANCELLED', 'FAILED'],
    'PROCESSING': ['COMPLETED', 'FAILED', 'CANCELLED'],
    'COMPLETED': ['REFUNDED'],
    'FAILED': ['PENDING'], // Allow retry
    'CANCELLED': ['PENDING'], // Allow retry
    'REFUNDED': [], // Terminal state
  }

  /**
   * Validate payment status transition
   */
  private static isValidPaymentTransition(
    fromStatus: string,
    toStatus: string
  ): boolean {
    return this.PAYMENT_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus) || false
  }

  /**
   * Create a new payment attempt with deduplication
   */
  static async createPaymentAttempt(
    data: CreatePaymentAttemptData,
    actorUserId?: string
  ): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      // Lock the order to prevent concurrent payment attempts
      const order = await tx.order.findUnique({
        where: { id: data.orderId },
        include: { paymentAttempts: true }
      })

      if (!order) {
        throw new Error('Order not found')
      }

      // Check for existing pending payment attempts for this order
      const existingPending = order.paymentAttempts.find(
        attempt => attempt.status === 'PENDING' || attempt.status === 'PROCESSING'
      )

      if (existingPending) {
        throw new Error('Payment attempt already in progress for this order')
      }

      // Create payment attempt
      const paymentAttempt = await tx.paymentAttempt.create({
        data: {
          orderId: data.orderId,
          provider: data.provider,
          providerReference: null,
          amountMinor: data.amountMinor,
          currency: data.currency,
          status: 'PENDING',
          failureReason: null,
          metadataJson: data.metadata ? JSON.stringify(data.metadata) : null,
        },
      })

      // Log payment initiation event
      await OrderEventService.createPaymentEvent(tx, data.orderId, actorUserId || null, OrderEventService.EVENT_TYPES.PAYMENT_INITIATED, {
        provider: data.provider,
        amountMinor: data.amountMinor,
        currency: data.currency,
      })

      logger.info('Payment attempt created', {
        paymentAttemptId: paymentAttempt.id,
        orderId: data.orderId,
        provider: data.provider,
        amountMinor: data.amountMinor,
      })

      return paymentAttempt
    })
  }

  /**
   * Update payment status with proper state management
   */
  static async updatePaymentStatus(
    data: UpdatePaymentStatusData,
    actorUserId?: string
  ): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      // Get current payment attempt with order
      const currentAttempt = await tx.paymentAttempt.findUnique({
        where: { id: data.paymentAttemptId },
        include: { order: true }
      })

      if (!currentAttempt) {
        throw new Error('Payment attempt not found')
      }

      // Validate status transition
      if (!this.isValidPaymentTransition(currentAttempt.status, data.status)) {
        throw new Error(`Invalid payment status transition from ${currentAttempt.status} to ${data.status}`)
      }

      // Update payment attempt
      const updatedAttempt = await tx.paymentAttempt.update({
        where: { id: data.paymentAttemptId },
        data: {
          status: data.status,
          providerReference: data.providerReference || currentAttempt.providerReference,
          failureReason: data.failureReason || null,
          metadataJson: data.metadata ? JSON.stringify(data.metadata) : null,
          updatedAt: new Date(),
        },
      })

      // Create appropriate payment event
      const eventType = this.getPaymentEventType(data.status)
      await OrderEventService.createPaymentEvent(tx, currentAttempt.orderId, actorUserId || null, eventType, {
        provider: currentAttempt.provider,
        amountMinor: currentAttempt.amountMinor,
        currency: currentAttempt.currency,
        providerReference: data.providerReference,
        failureReason: data.failureReason,
      })

      // Handle payment completion side effects
      if (data.status === 'COMPLETED') {
        await this.handlePaymentCompletion(tx, currentAttempt.orderId, actorUserId)
      }

      // Handle payment failure side effects
      if (data.status === 'FAILED' || data.status === 'CANCELLED') {
        await this.handlePaymentFailure(tx, currentAttempt.orderId, currentAttempt.status, actorUserId)
      }

      logger.info('Payment status updated', {
        paymentAttemptId: data.paymentAttemptId,
        from: currentAttempt.status,
        to: data.status,
        providerReference: data.providerReference,
      })

      return updatedAttempt
    })
  }

  /**
   * Process payment refund
   */
  static async refundPayment(
    data: RefundPaymentData,
    actorUserId?: string
  ): Promise<any> {
    return await prisma.$transaction(async (tx) => {
      // Get payment attempt
      const paymentAttempt = await tx.paymentAttempt.findUnique({
        where: { id: data.paymentAttemptId },
        include: { order: true }
      })

      if (!paymentAttempt) {
        throw new Error('Payment attempt not found')
      }

      if (paymentAttempt.status !== 'COMPLETED') {
        throw new Error('Only completed payments can be refunded')
      }

      if (data.refundAmountMinor > paymentAttempt.amountMinor) {
        throw new Error('Refund amount cannot exceed original payment amount')
      }

      // Update payment status to refunded
      const updatedAttempt = await tx.paymentAttempt.update({
        where: { id: data.paymentAttemptId },
        data: {
          status: 'REFUNDED',
          metadataJson: JSON.stringify({
            refundAmountMinor: data.refundAmountMinor,
            refundReason: data.reason,
            refundDate: new Date().toISOString(),
            ...(data.metadata || {}),
          }),
          updatedAt: new Date(),
        },
      })

      // Update order payment status
      await tx.order.update({
        where: { id: paymentAttempt.orderId },
        data: { paymentStatus: 'REFUNDED' }
      })

      // Log refund event
      await OrderEventService.createPaymentEvent(tx, paymentAttempt.orderId, actorUserId || null, OrderEventService.EVENT_TYPES.PAYMENT_REFUNDED, {
        provider: paymentAttempt.provider,
        amountMinor: data.refundAmountMinor,
        currency: paymentAttempt.currency,
      })

      logger.info('Payment refunded', {
        paymentAttemptId: data.paymentAttemptId,
        refundAmountMinor: data.refundAmountMinor,
        reason: data.reason,
      })

      return updatedAttempt
    })
  }

  /**
   * Get payment attempts for an order
   */
  static async getOrderPaymentAttempts(orderId: string) {
    return await prisma.paymentAttempt.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          select: {
            publicOrderNumber: true,
            status: true,
            paymentStatus: true,
          }
        }
      }
    })
  }

  /**
   * Get payment attempt by ID
   */
  static async getPaymentAttempt(paymentAttemptId: string) {
    return await prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      include: {
        order: {
          include: {
            customer: true,
            orderItems: true,
          }
        }
      }
    })
  }

  /**
   * Handle payment completion side effects
   */
  private static async handlePaymentCompletion(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorUserId?: string
  ) {
    // Update order payment status
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'PAID' }
    })

    // If order is still PENDING, confirm it
    const order = await tx.order.findUnique({
      where: { id: orderId }
    })

    if (order && order.status === 'PENDING') {
      // Update order status to CONFIRMED directly
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CONFIRMED' }
      })

      // Log status change event
      await OrderEventService.createStatusChangeEvent(
        tx,
        orderId,
        actorUserId || null,
        'PENDING',
        'CONFIRMED',
        'Payment completed'
      )
    }
  }

  /**
   * Handle payment failure side effects
   */
  private static async handlePaymentFailure(
    tx: Prisma.TransactionClient,
    orderId: string,
    paymentStatus: string,
    actorUserId?: string
  ) {
    // Update order payment status
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: paymentStatus === 'CANCELLED' ? 'CANCELLED' : 'FAILED' }
    })

    // Log payment failure event
    await OrderEventService.createEvent(tx, {
      orderId,
      actorUserId: actorUserId || null,
      eventType: 'PAYMENT_FAILED',
      payload: {
        paymentStatus,
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Map payment status to event type
   */
  private static getPaymentEventType(status: string): string {
    switch (status) {
      case 'PROCESSING':
        return OrderEventService.EVENT_TYPES.PAYMENT_CONFIRMED
      case 'COMPLETED':
        return OrderEventService.EVENT_TYPES.PAYMENT_CONFIRMED
      case 'FAILED':
        return OrderEventService.EVENT_TYPES.PAYMENT_FAILED
      case 'CANCELLED':
        return OrderEventService.EVENT_TYPES.PAYMENT_FAILED
      case 'REFUNDED':
        return OrderEventService.EVENT_TYPES.PAYMENT_REFUNDED
      default:
        return 'PAYMENT_STATUS_CHANGED'
    }
  }

  /**
   * Deduplicate payment attempts by provider reference
   */
  static async findPaymentByProviderReference(
    provider: string,
    providerReference: string
  ) {
    return await prisma.paymentAttempt.findFirst({
      where: {
        provider,
        providerReference,
      },
      include: {
        order: true,
      }
    })
  }

  /**
   * Get payment statistics for a seller
   */
  static async getSellerPaymentStats(sellerId: string, startDate?: Date, endDate?: Date) {
    const where: Prisma.PaymentAttemptWhereInput = {
      order: { sellerId },
    }

    if (startDate || endDate) {
      where.createdAt = {}
      if (startDate) where.createdAt.gte = startDate
      if (endDate) where.createdAt.lte = endDate
    }

    const attempts = await prisma.paymentAttempt.findMany({
      where,
      include: {
        order: {
          select: {
            totalMinor: true,
            currency: true,
          }
        }
      }
    })

    const stats = attempts.reduce((acc, attempt) => {
      acc.totalAttempts++
      acc.totalAmountMinor += attempt.amountMinor

      switch (attempt.status) {
        case 'COMPLETED':
          acc.completedPayments++
          acc.completedAmountMinor += attempt.amountMinor
          break
        case 'FAILED':
          acc.failedPayments++
          break
        case 'REFUNDED':
          acc.refundedPayments++
          acc.refundedAmountMinor += attempt.amountMinor
          break
      }

      return acc
    }, {
      totalAttempts: 0,
      totalAmountMinor: 0,
      completedPayments: 0,
      completedAmountMinor: 0,
      failedPayments: 0,
      refundedPayments: 0,
      refundedAmountMinor: 0,
    })

    return stats
  }
}
