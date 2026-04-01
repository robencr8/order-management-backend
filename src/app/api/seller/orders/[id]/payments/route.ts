import { prisma } from '@/server/db/prisma'
import { getCurrentUser, requireSeller } from '@/server/lib/auth'
import { ApiError, withParamsValidation } from '@/server/lib/errors'
import { IdSchema } from '@/server/lib/validation'
import { PaymentService } from '@/server/services/payment.service'
import { NextRequest, NextResponse } from 'next/server'

async function createPaymentAttempt(
  { id }: { id: string },
  request: NextRequest
) {
  const user = await getCurrentUser(request)
  requireSeller(user)

  // Verify order belongs to seller
  const order = await prisma.order.findFirst({
    where: {
      id,
      sellerId: user.sellerId!,
    },
  })

  if (!order) {
    throw new ApiError(404, 'Order not found')
  }

  const body = await request.json()
  const paymentAttempt = await PaymentService.createPaymentAttempt({
    orderId: id,
    provider: body.provider,
    amountMinor: body.amountMinor,
    currency: body.currency,
    metadata: body.metadata,
  }, user.id)

  return NextResponse.json({
    paymentAttempt,
    message: 'Payment attempt created successfully',
  })
}

async function getOrderPaymentAttempts(
  { id }: { id: string },
  request: NextRequest
) {
  const user = await getCurrentUser(request)
  requireSeller(user)

  // Verify order belongs to seller
  const order = await prisma.order.findFirst({
    where: {
      id,
      sellerId: user.sellerId!,
    },
  })

  if (!order) {
    throw new ApiError(404, 'Order not found')
  }

  const paymentAttempts = await PaymentService.getOrderPaymentAttempts(id)

  return NextResponse.json({
    paymentAttempts,
    order: {
      id: order.id,
      publicOrderNumber: order.publicOrderNumber,
      totalMinor: order.totalMinor,
      currency: order.currency,
      paymentStatus: order.paymentStatus,
    },
  })
}

export const POST = withParamsValidation(createPaymentAttempt, IdSchema)
export const GET = withParamsValidation(getOrderPaymentAttempts, IdSchema)
