import { z } from 'zod'

export const CreateOrderSchema = z.object({
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().min(1, 'Customer phone is required'),
  customerAddress: z.string().optional(),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().min(1, 'Quantity must be at least 1'),
  })).min(1, 'At least one item is required'),
  notes: z.string().optional(),
})

export const CreateProductSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  slug: z.string().min(1, 'Product slug is required'),
  description: z.string().optional(),
  priceMinor: z.number().min(0, 'Price must be non-negative'),
  currency: z.string().default('USD'),
  stockQuantity: z.number().min(0, 'Stock must be non-negative'),
  isActive: z.boolean().default(true),
})

export const UpdateProductSchema = CreateProductSchema.partial()

export const UpdateOrderStatusSchema = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']),
  reason: z.string().optional(),
})

export const SellerSlugSchema = z.object({
  sellerSlug: z.string().min(1, 'Seller slug is required'),
})

export const IdSchema = z.object({
  id: z.string().min(1, 'ID is required'),
})

export const PaginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']).optional(),
})

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>
export type CreateProductInput = z.infer<typeof CreateProductSchema>
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>
export type UpdateOrderStatusInput = z.infer<typeof UpdateOrderStatusSchema>
export type SellerSlugInput = z.infer<typeof SellerSlugSchema>
export type IdInput = z.infer<typeof IdSchema>
export type PaginationInput = z.infer<typeof PaginationSchema>
