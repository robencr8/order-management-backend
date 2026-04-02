import { prisma } from '@/server/db/prisma'
import { logger } from '@/server/lib/logger'
import { createOrderEvent } from '@/server/modules/orders/event.service'
import { NextRequest, NextResponse } from 'next/server'

// Payment constants (since schema uses strings, not enums)
const PAYMENT_PROVIDER = {
  STRIPE: 'STRIPE',
  SIMULATOR: 'SIMULATOR',
} as const

const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const

const WEBHOOK_STATUS = {
  PENDING: 'PENDING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
} as const

// Stripe webhook signature verification (simplified)
async function verifyStripeSignature(_payload: string, _signature: string): Promise<boolean> {
  // In production, you would use Stripe's webhook signing secret
  // For demo purposes, we'll just return true
  return true
}

async function processStripeWebhook(request: NextRequest) {
  const body = await request.text()
  const signature = request.headers.get('stripe-signature') || ''

  try {
    // Verify webhook signature
    const isValid = await verifyStripeSignature(body, signature)
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      )
    }

    const event = JSON.parse(body)

    // Check for duplicate webhook
    const existingWebhook = await prisma.webhookEvent.findUnique({
      where: {
        provider_eventId: {
          provider: PAYMENT_PROVIDER.STRIPE,
          eventId: event.id,
        },
      },
    })

    if (existingWebhook) {
      return NextResponse.json({ status: 'duplicate' })
    }

    // Store webhook event
    await prisma.$transaction(async (tx) => {
      // Create webhook event record
      await tx.webhookEvent.create({
        data: {
          provider: PAYMENT_PROVIDER.STRIPE,
          eventId: event.id,
          eventType: event.type,
          payloadJson: event,
          status: WEBHOOK_STATUS.PROCESSED,
          processedAt: new Date(),
        },
      })

      // Handle payment success
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object

        // Find payment attempt
        const paymentAttempt = await tx.paymentAttempt.findFirst({
          where: {
            provider: PAYMENT_PROVIDER.STRIPE,
            providerReference: paymentIntent.id,
          },
        })

        if (paymentAttempt) {
          // Update payment attempt
          await tx.paymentAttempt.update({
            where: { id: paymentAttempt.id },
            data: {
              status: PAYMENT_STATUS.PAID,
              rawPayloadJson: event,
            },
          })

          // Update order payment status
          await tx.order.update({
            where: { id: paymentAttempt.orderId },
            data: { paymentStatus: PAYMENT_STATUS.PAID },
          })

          // Create order event through centralized service
          await createOrderEvent(tx, {
            orderId: paymentAttempt.orderId,
            eventType: 'payment_completed',
            actorUserId: null, // System event
            payload: {
              paymentAttemptId: paymentAttempt.id,
              provider: 'STRIPE',
              amount: paymentAttempt.amountMinor,
            },
          })

          logger.info('Payment processed successfully', {
            provider: PAYMENT_PROVIDER.STRIPE,
            paymentIntentId: paymentIntent.id,
            orderId: paymentAttempt.orderId,
            amount: paymentIntent.amount,
          })
        }
      }
    })

    return NextResponse.json({ status: 'processed' })
  } catch (error) {
    logger.error('Webhook processing failed', error as Error)
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    )
  }
}

export const POST = processStripeWebhook
