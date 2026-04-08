import { NextRequest, NextResponse } from 'next/server'
import { ZodError, ZodSchema } from 'zod'

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type RouteHandler<T> = (data: T, request: NextRequest) => Promise<NextResponse>

type RouteContext<T> = {
  params: T
}

function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }))
}

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code ?? null,
      },
      { status: error.statusCode }
    )
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        details: formatZodError(error),
      },
      { status: 400 }
    )
  }

  console.error('Unhandled API error:', error)

  return NextResponse.json(
    { error: 'Internal server error' },
    { status: 500 }
  )
}

export function withValidation<T>(
  schema: ZodSchema<T>,
  handler: RouteHandler<T>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      const body = await request.json()
      const data = schema.parse(body)
      return await handler(data, request)
    } catch (error) {
      return handleApiError(error)
    }
  }
}

export function withParamsValidation<T>(
  handler: RouteHandler<T>,
  schema: ZodSchema<T>
) {
  return async (
    request: NextRequest,
    context: RouteContext<unknown>
  ): Promise<NextResponse> => {
    try {
      const data = schema.parse(context.params)
      return await handler(data, request)
    } catch (error) {
      return handleApiError(error)
    }
  }
}

export function withQueryValidation<T>(
  schema: ZodSchema<T>,
  handler: RouteHandler<T>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      const { searchParams } = new URL(request.url)
      const query = Object.fromEntries(searchParams.entries())
      const data = schema.parse(query)
      return await handler(data, request)
    } catch (error) {
      return handleApiError(error)
    }
  }
}
