import { getCurrentUser, requireSeller } from '@/server/lib/auth'
import { ApiError, withParamsValidation, withValidation } from '@/server/lib/errors'
import { IdSchema, UpdateOrderStatusSchema } from '@/server/lib/validation'
import { orderService } from '@/server/modules/orders/order.service'
import { OrderStatus } from '@/server/modules/orders/transitions'
import { NextRequest, NextResponse } from 'next/server'

async function updateOrderStatus(
  { id }: { id: string },
  { status, reason }: { status: OrderStatus; reason?: string },
  request: NextRequest
) {
  const user = await getCurrentUser(request)
  requireSeller(user)

  try {
    const updatedOrder = await orderService.updateOrderStatus({
      orderId: id,
      newStatus: status,
      actorUserId: user.id,
      reason
    })

    // Verify seller access
    if (updatedOrder.sellerId !== user.sellerId) {
      throw new ApiError(403, 'Access denied')
    }

    return NextResponse.json({
      order: {
        id: updatedOrder.id,
        publicOrderNumber: updatedOrder.publicOrderNumber,
        status: updatedOrder.status,
        updatedAt: updatedOrder.updatedAt,
      },
    })
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'OrderTransitionError') {
        throw new ApiError(400, error.message)
      }
      throw new ApiError(500, error.message)
    }
    throw new ApiError(500, 'Unknown error')
  }
}

export const PATCH = withParamsValidation(
  IdSchema,
  (params, request) =>
    withValidation(UpdateOrderStatusSchema, (data, req) =>
      updateOrderStatus(params, data, req)
    )(request)
)
