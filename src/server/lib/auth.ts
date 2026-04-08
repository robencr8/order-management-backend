import bcrypt from 'bcryptjs'
import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { prisma } from '../db/prisma'
import { ApiError } from './errors'

const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN: SignOptions['expiresIn'] = '7d'

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required')
}

type UserRole = 'STAFF' | 'SELLER' | 'ADMIN'

export interface AuthUser {
  id: string
  email: string
  role: UserRole
  sellerId: string | null
}

export interface AuthResult {
  user: AuthUser
  token: string
}

interface TokenPayload extends JwtPayload {
  id: string
  email: string
  role: UserRole
  sellerId: string | null
}

interface SellerAuthUser extends AuthUser {
  sellerId: string
  role: 'SELLER' | 'ADMIN'
}

interface AdminAuthUser extends AuthUser {
  role: 'ADMIN'
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(401, `Invalid token payload: ${fieldName}`)
  }
}

function normalizeTokenPayload(decoded: string | JwtPayload): TokenPayload {
  if (typeof decoded === 'string') {
    throw new ApiError(401, 'Invalid token')
  }

  assertNonEmptyString(decoded.id, 'id')
  assertNonEmptyString(decoded.email, 'email')
  assertNonEmptyString(decoded.role, 'role')

  const allowedRoles: UserRole[] = ['STAFF', 'SELLER', 'ADMIN']
  if (!allowedRoles.includes(decoded.role as UserRole)) {
    throw new ApiError(401, 'Invalid token role')
  }

  return {
    ...decoded,
    id: decoded.id,
    email: decoded.email,
    role: decoded.role as UserRole,
    sellerId: typeof decoded.sellerId === 'string' ? decoded.sellerId : null,
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function generateToken(user: AuthUser): string {
  const payload: Omit<TokenPayload, keyof JwtPayload> = {
    id: user.id,
    email: user.email,
    role: user.role,
    sellerId: user.sellerId,
  }

  return jwt.sign(payload, JWT_SECRET!, {
    expiresIn: JWT_EXPIRES_IN,
  })
}

export function verifyToken(token: string): AuthUser {
  try {
    const decoded = jwt.verify(token, JWT_SECRET!)
    const payload = normalizeTokenPayload(decoded)

    return {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      sellerId: payload.sellerId,
    }
  } catch {
    throw new ApiError(401, 'Invalid token')
  }
}

export async function authenticateUser(
  email: string,
  password: string
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: {
      ownedSeller: {
        select: { id: true },
      },
    },
  })

  if (!user || !user.isActive) {
    throw new ApiError(401, 'Invalid credentials')
  }

  const isValidPassword = await verifyPassword(password, user.passwordHash)

  if (!isValidPassword) {
    throw new ApiError(401, 'Invalid credentials')
  }

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    sellerId: user.ownedSeller?.id ?? null,
  }

  return {
    user: authUser,
    token: generateToken(authUser),
  }
}

export async function getCurrentUser(request: NextRequest): Promise<AuthUser> {
  const authHeader = request.headers.get('authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    throw new ApiError(401, 'No token provided')
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    throw new ApiError(401, 'No token provided')
  }

  return verifyToken(token)
}

export function requireSeller(user: AuthUser): SellerAuthUser {
  if (user.role !== 'SELLER' && user.role !== 'ADMIN') {
    throw new ApiError(403, 'Seller access required')
  }

  if (!user.sellerId) {
    throw new ApiError(403, 'No seller associated with account')
  }

  return user as SellerAuthUser
}

export function requireAdmin(user: AuthUser): AdminAuthUser {
  if (user.role !== 'ADMIN') {
    throw new ApiError(403, 'Admin access required')
  }

  return user as AdminAuthUser
}
