import { prisma } from '../../server/db/prisma'
import { hashPassword } from '../../server/lib/auth'

describe('Basic System Tests', () => {
  test('database connection works', async () => {
    // Simple test to verify database connection
    const userCount = await prisma.user.count()
    expect(typeof userCount).toBe('number')
  })

  test('password hashing works', async () => {
    const password = 'test-password-123'
    const hash = await hashPassword(password)

    expect(hash).not.toBe(password)
    expect(hash.length).toBeGreaterThan(50) // bcrypt hashes are long
  })

  test('can create and find user', async () => {
    const userData = {
      id: `test-user-${Date.now()}`,
      email: `test-${Date.now()}@example.com`,
      fullName: 'Test User',
      passwordHash: await hashPassword('test-password'),
      isActive: true
    }

    const user = await prisma.user.create({ data: userData })

    expect(user.id).toBe(userData.id)
    expect(user.email).toBe(userData.email)
    expect((user as any).passwordHash).toBe(userData.passwordHash)
    expect(user.isActive).toBe(true)

    // Cleanup
    await prisma.user.delete({ where: { id: user.id } })
  })
})
