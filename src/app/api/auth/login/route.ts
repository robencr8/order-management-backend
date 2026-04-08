import { authenticateUser } from '@/server/lib/auth'
import { ApiError, withValidation } from '@/server/lib/errors'
import { RATE_LIMIT_CONFIGS, createRateLimit } from '@/server/lib/rate-limit-redis'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

const LoginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(1, 'Password is required'),
})

// Apply strict rate limiting to auth endpoints
const rateLimit = createRateLimit(RATE_LIMIT_CONFIGS.AUTH)

async function login(loginData: unknown, request: NextRequest) {
  // Rate limiting first
  const rateLimitResult = await rateLimit(request)
  if (!rateLimitResult.success) {
    throw new ApiError(429, 'Too many login attempts')
  }

  const { email, password } = loginData as { email: string; password: string }

  try {
    const { user, token } = await authenticateUser(email, password)

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        sellerId: user.sellerId,
      },
      token,
    })
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode }
      )
    }
    throw error
  }
}

async function logout() {
  // In a real implementation, you might want to invalidate the token
  // For now, we'll just return a success response
  return NextResponse.json({ success: true })
}

export const POST = withValidation(LoginSchema, (data, request) =>
  login(data, request)
)

export const DELETE = logout
