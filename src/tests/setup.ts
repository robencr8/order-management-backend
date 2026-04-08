import { PrismaClient } from '@prisma/client'
import { vi } from 'vitest'

// Mock NextRequest for API tests
vi.mock('next/server', () => ({
  NextRequest: class MockNextRequest {
    constructor(url: string, init?: RequestInit) {
      this.url = url
      this.method = init?.method || 'GET'
      this.headers = new Headers(init?.headers)
      this.body = init?.body
    }
    url: string
    method: string
    headers: Headers
    body: unknown
    ip = '127.0.0.1'
    json = () => Promise.resolve(this.body)
    text = () => Promise.resolve(this.body)
  },
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => ({
      ...init,
      json: () => Promise.resolve(data),
      status: init?.status || 200,
    }),
  },
}))

// Setup test environment variables
process.env.JWT_SECRET = 'test-jwt-secret'
process.env.DATABASE_URL = 'file:./test.db'

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'file:./test.db'
    }
  }
})

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.orderEvent.deleteMany()
  await prisma.paymentAttempt.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.customer.deleteMany()
  await prisma.product.deleteMany()
  await prisma.seller.deleteMany()
  await prisma.user.deleteMany()
})

  ; (global as any).prisma = prisma

export { prisma }

