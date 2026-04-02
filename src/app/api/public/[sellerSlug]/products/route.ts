import { NextRequest, NextResponse } from 'next/server'
import { withParamsValidation, ApiError } from '@/server/lib/errors'
import { SellerSlugSchema } from '@/server/lib/validation'

async function getPublicProducts(
  { sellerSlug }: { sellerSlug: string },
  request: NextRequest
) {
  // TODO: Implement public products endpoint
  throw new ApiError(501, 'Not implemented yet')
}

export const GET = withParamsValidation(getPublicProducts, SellerSlugSchema)
