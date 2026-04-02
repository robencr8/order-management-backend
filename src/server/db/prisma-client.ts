// Temporary workaround for Prisma client generation issues
import { PrismaClient as GeneratedPrismaClient } from '@prisma/client'

// Create a mock client for now
export const prisma = new GeneratedPrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL || 'file:./dev.db'
    }
  }
})

export type PrismaClient = GeneratedPrismaClient
