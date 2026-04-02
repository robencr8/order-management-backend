import { z } from 'zod'

const OrderStatusValues = [
  'PENDING',
  'CONFIRMED',
  'PACKED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const

const normalizedString = (field: string) =>
  z.string().trim().min(1, `${field} is required`)

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()

const cuidLikeId = z.string().trim().min(1, 'ID is required')

const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Customer phone is required')
  .max(32, 'Customer phone is too long')

const orderItemSchema = z.object({
  productId: cuidLikeId,
  quantity: z.coerce.number().int('Quantity must be an integer').min(1, 'Quantity must be at least 1'),
})

export const CreateOrderSchema = z.object({
  customerName: normalizedString('Customer name').max(120, 'Customer name is too long'),
  customerPhone: phoneSchema,
  customerAddress: optionalTrimmedString,
  items: z
    .array(orderItemSchema)
    .min(1, 'At least one item is required')
    .superRefine((items, ctx) => {
      const seen = new Set<string>()

      for (const [index, item] of items.entries()) {
        if (seen.has(item.productId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'productId'],
            message: 'Duplicate productId is not allowed',
          })
        }
        seen.add(item.productId)
      }
    }),
  notes: optionalTrimmedString,
})

export const CreateProductSchema = z.object({
  name: normalizedString('Product name').max(200, 'Product name is too long'),
  slug: z
    .string()
    .trim()
    .min(1, 'Product slug is required')
    .max(120, 'Product slug is too long')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens only'),
  description: optionalTrimmedString,
  priceMinor: z.coerce.number().int('Price must be an integer').min(0, 'Price must be non-negative'),
  currency: z
    .string()
    .trim()
    .length(3, 'Currency must be a 3-letter ISO code')
    .transform((value) => value.toUpperCase())
    .default('USD'),
  stockQuantity: z.coerce.number().int('Stock must be an integer').min(0, 'Stock must be non-negative'),
  isActive: z.coerce.boolean().default(true),
})

export const UpdateProductSchema = CreateProductSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one product field must be provided',
  })

export const UpdateOrderStatusSchema = z.object({
  status: z.enum(OrderStatusValues),
  reason: optionalTrimmedString,
})

export const SellerSlugSchema = z.object({
  sellerSlug: z
    .string()
    .trim()
    .min(1, 'Seller slug is required')
    .max(120, 'Seller slug is too long')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Seller slug must be lowercase letters, numbers, and hyphens only'),
})

export const IdSchema = z.object({
  id: cuidLikeId,
})

export const PaginationSchema = z.object({
  page: z.coerce.number().int('Page must be an integer').min(1).default(1),
  limit: z.coerce.number().int('Limit must be an integer').min(1).max(100).default(20),
  status: z.enum(OrderStatusValues).optional(),
})

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>
export type CreateProductInput = z.infer<typeof CreateProductSchema>
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>
export type UpdateOrderStatusInput = z.infer<typeof UpdateOrderStatusSchema>
export type SellerSlugInput = z.infer<typeof SellerSlugSchema>
export type IdInput = z.infer<typeof IdSchema>
export type PaginationInput = z.infer<typeof PaginationSchema>
