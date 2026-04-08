import { ApiError, withParamsValidation } from '@/server/lib/errors'
import { SellerSlugSchema } from '@/server/lib/validation'
import { NextRequest, NextResponse } from 'next/server'

async function getPublicOrders(
  { sellerSlug: _sellerSlug }: { sellerSlug: string },
  _request: NextRequest
): Promise<NextResponse> {
  // TODO: Implement public orders endpoint
  throw new ApiError(501, 'Not implemented yet')
}

export const GET = withParamsValidation(getPublicOrders, SellerSlugSchema)
