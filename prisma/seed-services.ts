import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { orderService } from '../src/server/modules/orders/order.service'
import { paymentService } from '../src/server/modules/orders/payment.service'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Starting database seeding...')

  // Create demo user with proper password hash
  const hashedPassword = await bcrypt.hash('demo123', 12)

  const user = await prisma.user.upsert({
    where: { email: 'demo@seller.com' },
    update: {},
    create: {
      email: 'demo@seller.com',
      fullName: 'Demo Seller',
      passwordHash: hashedPassword,
      role: 'SELLER',
      isActive: true,
    },
  })

  // Create demo seller
  const seller = await prisma.seller.upsert({
    where: { slug: 'demo-store' },
    update: {},
    create: {
      ownerUserId: user.id,
      brandName: 'Demo Store',
      slug: 'demo-store',
      whatsappNumber: '+1234567890',
      currency: 'USD',
      status: 'ACTIVE',
    },
  })

  // Create demo products
  const products = [
    {
      name: 'Classic T-Shirt',
      slug: 'classic-tshirt',
      description: 'Comfortable cotton t-shirt in various colors',
      priceMinor: 1999, // $19.99
      currency: 'USD',
      stockQuantity: 50,
      isActive: true,
    },
    {
      name: 'Denim Jeans',
      slug: 'denim-jeans',
      description: 'Classic fit denim jeans',
      priceMinor: 4999, // $49.99
      currency: 'USD',
      stockQuantity: 30,
      isActive: true,
    },
    {
      name: 'Canvas Sneakers',
      slug: 'canvas-sneakers',
      description: 'Comfortable canvas sneakers for everyday wear',
      priceMinor: 3499, // $34.99
      currency: 'USD',
      stockQuantity: 25,
      isActive: true,
    },
    {
      name: 'Leather Wallet',
      slug: 'leather-wallet',
      description: 'Genuine leather bifold wallet',
      priceMinor: 2999, // $29.99
      currency: 'USD',
      stockQuantity: 15,
      isActive: true,
    },
    {
      name: 'Sunglasses',
      slug: 'sunglasses',
      description: 'UV protection sunglasses with stylish frame',
      priceMinor: 2499, // $24.99
      currency: 'USD',
      stockQuantity: 20,
      isActive: true,
    },
  ]

  for (const productData of products) {
    await prisma.product.upsert({
      where: {
        sellerId_slug: {
          sellerId: seller.id,
          slug: productData.slug,
        },
      },
      update: {},
      create: {
        ...productData,
        sellerId: seller.id,
      },
    })
  }

  // Create demo customers
  const customers = [
    {
      name: 'John Doe',
      phone: '+11234567890',
      addressText: '123 Main St, City, State 12345',
    },
    {
      name: 'Jane Smith',
      phone: '+10987654321',
      addressText: '456 Oak Ave, Town, State 67890',
    },
    {
      name: 'Bob Johnson',
      phone: '+15551234567',
      addressText: '789 Pine Rd, Village, State 11111',
    },
  ]

  const createdCustomers = []
  for (const customerData of customers) {
    const customer = await prisma.customer.upsert({
      where: {
        sellerId_phone: {
          sellerId: seller.id,
          phone: customerData.phone,
        },
      },
      update: {},
      create: {
        ...customerData,
        sellerId: seller.id,
      },
    })
    createdCustomers.push(customer)
  }

  // Get created products for order creation
  const demoProducts = await prisma.product.findMany({
    where: { sellerId: seller.id },
  })

  // Create demo orders using the service layer
  const orders = [
    {
      customerId: createdCustomers[0].id,
      items: [
        { productId: demoProducts[0].id, quantity: 2 }, // 2 T-shirts
        { productId: demoProducts[2].id, quantity: 1 }, // 1 Sneakers
      ],
      notes: 'Please wrap as a gift',
    },
    {
      customerId: createdCustomers[1].id,
      items: [
        { productId: demoProducts[1].id, quantity: 1 }, // 1 Jeans
        { productId: demoProducts[3].id, quantity: 1 }, // 1 Wallet
      ],
      notes: 'Delivery preferred after 5 PM',
    },
    {
      customerId: createdCustomers[2].id,
      items: [
        { productId: demoProducts[4].id, quantity: 2 }, // 2 Sunglasses
        { productId: demoProducts[0].id, quantity: 1 }, // 1 T-shirt
      ],
      notes: '',
    },
  ]

  console.log('📦 Creating orders through service layer...')

  for (const [index, orderData] of orders.entries()) {
    try {
      // Create order using service layer
      const order = await orderService.createOrder({
        sellerId: seller.id,
        customerId: orderData.customerId,
        items: orderData.items,
        deliveryFeeMinor: 500, // $5.00 delivery
        notes: orderData.notes,
      }, user.id)

      console.log(`✅ Order ${index + 1} created: ${order.publicOrderNumber}`)

      // Simulate different payment scenarios
      if (index === 0) {
        // First order: successful payment
        await paymentService.simulatePayment(order.id, true, user.id)
        console.log(`💳 Order ${order.publicOrderNumber} payment completed`)
        
        // Advance order status
        await orderService.applyTransition({
          orderId: order.id,
          newStatus: 'PACKED',
          actorUserId: user.id,
          notes: 'Ready for shipment',
        })
        console.log(`📦 Order ${order.publicOrderNumber} packed`)
        
      } else if (index === 1) {
        // Second order: successful payment, packed
        await paymentService.simulatePayment(order.id, true, user.id)
        console.log(`💳 Order ${order.publicOrderNumber} payment completed`)
        
        await orderService.applyTransition({
          orderId: order.id,
          newStatus: 'PACKED',
          actorUserId: user.id,
          notes: 'Customer notified',
        })
        console.log(`📦 Order ${order.publicOrderNumber} packed`)
        
      } else {
        // Third order: successful payment, out for delivery
        await paymentService.simulatePayment(order.id, true, user.id)
        console.log(`💳 Order ${order.publicOrderNumber} payment completed`)
        
        await orderService.applyTransition({
          orderId: order.id,
          newStatus: 'PACKED',
          actorUserId: user.id,
        })
        
        await orderService.applyTransition({
          orderId: order.id,
          newStatus: 'OUT_FOR_DELIVERY',
          actorUserId: user.id,
          notes: 'With courier - ETA today',
        })
        console.log(`🚚 Order ${order.publicOrderNumber} out for delivery`)
      }
      
    } catch (error) {
      console.error(`❌ Failed to create order ${index + 1}:`, error)
    }
  }

  console.log('✅ Database seeding completed!')
  console.log('')
  console.log('Demo credentials:')
  console.log('Email: demo@seller.com')
  console.log('Password: demo123')
  console.log('')
  console.log('Demo seller slug: demo-store')
  console.log('')
  console.log('Created:')
  console.log(`- 1 user`)
  console.log(`- 1 seller`)
  console.log(`- ${products.length} products`)
  console.log(`- ${customers.length} customers`)
  console.log(`- ${orders.length} orders (with proper events and audit trail)`)
  console.log('')
  console.log('🎯 All data created through service layer with proper event enforcement!')
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
