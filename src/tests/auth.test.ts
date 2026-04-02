import { describe, it, expect, beforeEach } from 'vitest'
import { hashPassword, authenticateUser } from '../server/lib/auth'
import { prisma } from '../tests/setup'

describe('Authentication', () => {
  beforeEach(async () => {
    await prisma.user.deleteMany()
  })

  describe('hashPassword', () => {
    it('should hash a password', async () => {
      const password = 'test123'
      const hashedPassword = await hashPassword(password)
      
      expect(hashedPassword).toBeDefined()
      expect(hashedPassword).not.toBe(password)
      expect(hashedPassword.length).toBeGreaterThan(50)
    })

    it('should generate different hashes for same password', async () => {
      const password = 'test123'
      const hash1 = await hashPassword(password)
      const hash2 = await hashPassword(password)
      
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('authenticateUser', () => {
    it('should authenticate with correct credentials', async () => {
      const email = 'test@example.com'
      const password = 'test123'
      const hashedPassword = await hashPassword(password)
      
      await prisma.user.create({
        data: {
          email,
          fullName: 'Test User',
          passwordHash: hashedPassword,
          role: 'SELLER',
          isActive: true,
        },
      })

      const result = await authenticateUser(email, password)
      
      expect(result).toBeDefined()
      expect(result.user.email).toBe(email)
      expect(result.user.role).toBe('SELLER')
      expect(result.token).toBeDefined()
    })

    it('should reject with wrong password', async () => {
      const email = 'test@example.com'
      const password = 'test123'
      const hashedPassword = await hashPassword(password)
      
      await prisma.user.create({
        data: {
          email,
          fullName: 'Test User',
          passwordHash: hashedPassword,
          role: 'SELLER',
          isActive: true,
        },
      })

      await expect(authenticateUser(email, 'wrongpassword')).rejects.toThrow('Invalid credentials')
    })

    it('should reject inactive user', async () => {
      const email = 'test@example.com'
      const password = 'test123'
      const hashedPassword = await hashPassword(password)
      
      await prisma.user.create({
        data: {
          email,
          fullName: 'Test User',
          passwordHash: hashedPassword,
          role: 'SELLER',
          isActive: false,
        },
      })

      await expect(authenticateUser(email, password)).rejects.toThrow('Invalid credentials')
    })

    it('should reject non-existent user', async () => {
      await expect(authenticateUser('nonexistent@example.com', 'password')).rejects.toThrow('Invalid credentials')
    })
  })
})
