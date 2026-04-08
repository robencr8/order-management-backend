import { prisma } from '../../db/prisma'
import { ApiError } from '../../lib/errors'
import { logger } from '../../lib/logger'
import { createOrderEvent } from './event.service'

export interface InitiatePaymentRequest {
  orderId: string
  provider: string
  paymentType?: string
}

export interface ConfirmPaymentRequest {
  orderId: string
  provider: string
  providerReference: string
  amountMinor?: number
}

export interface FailPaymentRequest {
  orderId: string
  provider: string
  providerReference?: string
  reason: string
}

export interface RefundPaymentRequest {
  orderId: string
  provider: string
  amountMinor: number
  reason?: string
}

export interface PaymentAttempt {
  id: string
  orderId: string
  provider: string
  providerReference: string | null
  amountMinor: number
  currency: string
  status: string
  paymentType: string | null
  failureReason: string | null
  metadataJson: string | null
  rawPayloadJson: string | null
  createdAt: Date
  updatedAt: Date
}

// Payment state machine (for future use)
// const PAYMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
//   PENDING: ['PROCESSING', 'FAILED'],
//   PROCESSING: ['COMPLETED', 'FAILED'],
//   COMPLETED: ['REFUNDED'],
//   FAILED: ['PENDING'], // Can retry failed payments
//   REFUNDED: [], // Terminal state
// }

export class PaymentService {
  async initiatePayment(request: InitiatePaymentRequest, actorUserId?: string): Promise<PaymentAttempt> {
    const { orderId, provider, paymentType = 'CASH_ON_DELIVERY' } = request

    logger.info('Initiating payment', { orderId, provider, paymentType })

    // Get order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { seller: true },
    })

    if (!order) {
      throw new ApiError(404, 'Order not found')
    }

    // Check if payment can be initiated
    if (order.paymentStatus === 'COMPLETED') {
      throw new ApiError(400, 'Payment already completed')
    }

    if (order.paymentStatus === 'PROCESSING') {
      throw new ApiError(400, 'Payment already in progress')
    }

    // Create payment attempt
    const paymentAttempt = await prisma.$transaction(async (tx) => {
      // Update order payment status
      await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'PROCESSING' },
      })

      // Create payment attempt
      const attempt = await tx.paymentAttempt.create({
        data: {
          orderId,
          provider,
          amountMinor: order.totalMinor,
          currency: order.currency,
          status: 'PROCESSING',
          paymentType,
          metadataJson: JSON.stringify({
            initiatedAt: new Date().toISOString(),
            actorUserId,
          }),
        },
      })

      // Create payment event
      await createOrderEvent(tx, {
        orderId,
        eventType: 'payment_initiated',
        actorUserId,
        payload: {
          provider,
          amountMinor: order.totalMinor,
          paymentType,
          attemptId: attempt.id,
        },
      })

      return attempt
    })

    logger.info('Payment initiated', {
      attemptId: paymentAttempt.id,
      orderId,
      provider,
      amountMinor: paymentAttempt.amountMinor
    })

    return paymentAttempt
  }

  async confirmPayment(request: ConfirmPaymentRequest, actorUserId?: string): Promise<PaymentAttempt> {
    const { orderId, provider, providerReference, amountMinor } = request

    logger.info('Confirming payment', { orderId, provider, providerReference })

    // Get order and current payment attempt
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    })

    if (!order) {
      throw new ApiError(404, 'Order not found')
    }

    // Get the processing payment attempt
    const currentAttempt = await prisma.paymentAttempt.findFirst({
      where: {
        orderId,
        provider,
        status: 'PROCESSING',
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!currentAttempt) {
      throw new ApiError(404, 'No processing payment found')
    }

    // Validate amount if provided
    if (amountMinor && amountMinor !== order.totalMinor) {
      throw new ApiError(400, 'Payment amount does not match order total')
    }

    // Confirm payment in transaction
    const confirmedAttempt = await prisma.$transaction(async (tx) => {
      // Update payment attempt
      const attempt = await tx.paymentAttempt.update({
        where: { id: currentAttempt.id },
        data: {
          status: 'COMPLETED',
          providerReference,
          metadataJson: JSON.stringify({
            ...JSON.parse(currentAttempt.metadataJson || '{}'),
            confirmedAt: new Date().toISOString(),
            actorUserId,
          }),
        },
      })

      // Update order payment status
      await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'COMPLETED' },
      })

      // Auto-confirm order if still pending
      if (order.status === 'PENDING') {
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'CONFIRMED' },
        })

        // Create status change event
        await createOrderEvent(tx, {
          orderId,
          eventType: 'status_changed',
          actorUserId,
          payload: {
            from: 'PENDING',
            to: 'CONFIRMED',
            reason: 'payment_completed',
          },
        })
      }

      // Create payment completion event
      await createOrderEvent(tx, {
        orderId,
        eventType: 'payment_completed',
        actorUserId,
        payload: {
          provider,
          amountMinor: attempt.amountMinor,
          providerReference,
          attemptId: attempt.id,
        },
      })

      return attempt
    })

    logger.info('Payment confirmed', {
      attemptId: confirmedAttempt.id,
      orderId,
      provider,
      providerReference,
      amountMinor: confirmedAttempt.amountMinor
    })

    return confirmedAttempt
  }

  async failPayment(request: FailPaymentRequest, actorUserId?: string): Promise<PaymentAttempt> {
    const { orderId, provider, providerReference, reason } = request

    logger.info('Failing payment', { orderId, provider, reason })

    // Get order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    })

    if (!order) {
      throw new ApiError(404, 'Order not found')
    }

    // Get the processing payment attempt
    const currentAttempt = await prisma.paymentAttempt.findFirst({
      where: {
        orderId,
        provider,
        status: 'PROCESSING',
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!currentAttempt) {
      throw new ApiError(404, 'No processing payment found')
    }

    // Fail payment in transaction
    const failedAttempt = await prisma.$transaction(async (tx) => {
      // Update payment attempt
      const attempt = await tx.paymentAttempt.update({
        where: { id: currentAttempt.id },
        data: {
          status: 'FAILED',
          providerReference,
          failureReason: reason,
          metadataJson: JSON.stringify({
            ...JSON.parse(currentAttempt.metadataJson || '{}'),
            failedAt: new Date().toISOString(),
            actorUserId,
          }),
        },
      })

      // Update order payment status
      await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'FAILED' },
      })

      // Create payment failed event
      await createOrderEvent(tx, {
        orderId,
        eventType: 'payment_failed',
        actorUserId,
        payload: {
          provider,
          reason,
          providerReference,
          attemptId: attempt.id,
        },
      })

      return attempt
    })

    logger.warn('Payment failed', {
      attemptId: failedAttempt.id,
      orderId,
      provider,
      reason
    })

    return failedAttempt
  }

  async refundPayment(request: RefundPaymentRequest, actorUserId?: string): Promise<PaymentAttempt> {
    const { orderId, provider, amountMinor, reason } = request

    logger.info('Refunding payment', { orderId, provider, amountMinor, reason })

    // Get order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    })

    if (!order) {
      throw new ApiError(404, 'Order not found')
    }

    if (order.paymentStatus !== 'COMPLETED') {
      throw new ApiError(400, 'Can only refund completed payments')
    }

    // Get the completed payment attempt
    const completedAttempt = await prisma.paymentAttempt.findFirst({
      where: {
        orderId,
        provider,
        status: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!completedAttempt) {
      throw new ApiError(404, 'No completed payment found')
    }

    // Create refund in transaction
    const refundAttempt = await prisma.$transaction(async (tx) => {
      // Create new payment attempt for refund
      const attempt = await tx.paymentAttempt.create({
        data: {
          orderId,
          provider,
          amountMinor: -amountMinor, // Negative amount for refund
          currency: order.currency,
          status: 'COMPLETED',
          paymentType: 'REFUND',
          metadataJson: JSON.stringify({
            refundedAt: new Date().toISOString(),
            actorUserId,
            originalAttemptId: completedAttempt.id,
            reason,
          }),
        },
      })

      // Update order payment status
      await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'REFUNDED' },
      })

      // Create refund event
      await createOrderEvent(tx, {
        orderId,
        eventType: 'payment_refunded',
        actorUserId,
        payload: {
          provider,
          amountMinor,
          reason,
          originalAttemptId: completedAttempt.id,
          refundAttemptId: attempt.id,
        },
      })

      return attempt
    })

    logger.info('Payment refunded', {
      refundAttemptId: refundAttempt.id,
      orderId,
      provider,
      amountMinor
    })

    return refundAttempt
  }

  async getPaymentAttempts(orderId: string): Promise<PaymentAttempt[]> {
    return prisma.paymentAttempt.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async getLatestPaymentAttempt(orderId: string): Promise<PaymentAttempt | null> {
    return prisma.paymentAttempt.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async simulatePayment(orderId: string, success: boolean = true, actorUserId?: string): Promise<PaymentAttempt> {
    logger.info('Simulating payment', { orderId, success })

    // Initiate payment first
    await this.initiatePayment({
      orderId,
      provider: 'SIMULATOR',
      paymentType: 'SIMULATION',
    }, actorUserId)

    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 100))

    if (success) {
      return this.confirmPayment({
        orderId,
        provider: 'SIMULATOR',
        providerReference: `SIM-${Date.now()}`,
      }, actorUserId)
    } else {
      return this.failPayment({
        orderId,
        provider: 'SIMULATOR',
        reason: 'Simulated payment failure',
      }, actorUserId)
    }
  }
}

export const paymentService = new PaymentService()
