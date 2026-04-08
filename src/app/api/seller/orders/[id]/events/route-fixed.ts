import { prisma } from '@/server/db/prisma'
import { getCurrentUser, requireSeller } from '@/server/lib/auth'
import { ApiError, withParamsValidation } from '@/server/lib/errors'
import { IdSchema } from '@/server/lib/validation'
import { NextRequest, NextResponse } from 'next/server'

function safeParseJson(value: string | null) {
  if (!value) return null

  try {
    return JSON.parse(value)
  } catch {
    return { raw: value }
  }
}

async function getOrderEvents(
  { id }: { id: string },
  request: NextRequest
) {
  const user = await getCurrentUser(request)
  const seller = requireSeller(user)

  const order = await prisma.order.findFirst({
    where: {
      id,
      sellerId: seller.sellerId,
    },
    select: {
      id: true,
      publicOrderNumber: true,
      status: true,
    },
  })

  if (!order) {
    throw new ApiError(404, 'Order not found')
  }

  const events = await prisma.orderEvent.findMany({
    where: { orderId: id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      actorUserId: true,
      eventType: true,
      payloadJson: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    order,
    events: events.map((event) => ({
      id: event.id,
      actorUserId: event.actorUserId,
      eventType: event.eventType,
      payload: safeParseJson(event.payloadJson),
      createdAt: event.createdAt,
    })),
  })
}

export const GET = withParamsValidation(getOrderEvents, IdSchema)
