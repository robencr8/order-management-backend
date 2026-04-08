# Order Management Backend

A production-grade order management system with service-oriented architecture, event sourcing, and comprehensive testing.

## 🏗️ Architecture

- **Service Layer**: Clean separation with `OrderService`, `PaymentService`, `EventService`
- **Event Sourcing**: Every action creates audit events
- **Authentication**: Real password hashing with bcrypt
- **Rate Limiting**: Redis-backed with memory fallback
- **Testing**: Vitest with unit and integration tests

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Setup database
npm run db:seed

# Start development server
npm run dev

# Run tests
npm run test:unit
npm run test:integration
```

## 📋 Available Scripts

### Development

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server

### Testing

- `npm run test` - Run all tests
- `npm run test:unit` - Run unit tests only
- `npm run test:integration` - Run integration tests only
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Generate coverage report
- `npm run test:ui` - Open test UI

### Database

- `npm run db:generate` - Generate Prisma client
- `npm run db:migrate` - Run migrations
- `npm run db:studio` - Open Prisma Studio
- `npm run db:seed` - Reset and seed database
- `npm run seed` - Seed database only

### Code Quality

- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint issues
- `npm run typecheck` - Run TypeScript type checking

## 🏛️ Service Layer

### Order Service

```typescript
import { orderService } from './server/modules/orders/order.service'

// Create order with full validation and events
const order = await orderService.createOrder({
  sellerId,
  customerId,
  items: [...],
  deliveryFeeMinor: 500,
}, actorUserId)

// Apply status transitions with validation
await orderService.applyTransition({
  orderId,
  newStatus: 'PACKED',
  actorUserId
})
```

### Payment Service

```typescript
import { paymentService } from "./server/modules/orders/payment.service";

// Simulate payment with automatic order updates
await paymentService.simulatePayment(orderId, true, actorUserId);

// Real payment processing
await paymentService.initiatePayment({ orderId, provider });
await paymentService.confirmPayment({ orderId, provider, providerReference });
```

### Event Service

```typescript
import { eventService } from "./server/modules/orders/event.service";

// Query audit trail
const events = await eventService.getOrderEvents(orderId);
```

## 🔐 Authentication

Real authentication with password hashing:

```typescript
import { authenticateUser } from "./server/lib/auth";

const { user, token } = await authenticateUser(email, password);
```

Demo credentials:

- Email: `demo@seller.com`
- Password: `demo123`

## 📊 Event Sourcing

Every action creates immutable events:

- `order_created` - New order creation
- `payment_initiated` - Payment started
- `payment_completed` - Payment successful
- `status_changed` - Order status updates
- `payment_failed` - Payment failures

## 🧪 Testing

Comprehensive test suite with Vitest:

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# Full coverage
npm run test:coverage
```

## 🏗️ Database Schema

- **Users**: Authentication and roles
- **Sellers**: Store management
- **Products**: Inventory with stock tracking
- **Customers**: Customer information
- **Orders**: Order management with status
- **OrderItems**: Line items with snapshots
- **OrderEvents**: Complete audit trail
- **PaymentAttempts**: Payment processing

## 🚨 Rate Limiting

Redis-backed rate limiting with memory fallback:

- **Public API**: 10 requests/minute
- **Auth endpoints**: 5 requests/minute
- **Seller API**: 100 requests/minute

## 📝 Logging

Structured JSON logging with request IDs:

```typescript
logger.info("Order created", { orderId, sellerId });
logger.error("Payment failed", { orderId, reason });
```

## 🔄 State Machines

### Order Status Transitions

```
PENDING → CONFIRMED → PACKED → OUT_FOR_DELIVERY → DELIVERED
    ↓         ↓         ↓           ↓
  CANCELLED  CANCELLED  CANCELLED  CANCELLED
```

### Payment Status Transitions

```
PENDING → PROCESSING → COMPLETED → REFUNDED
    ↓         ↓
  FAILED    FAILED
```

## 🌍 Environment Variables

```env
# Database
DATABASE_URL="file:./dev.db"

# Authentication
JWT_SECRET="your-jwt-secret"

# Rate Limiting (Optional)
REDIS_URL="redis://localhost:6379"
```

## 📦 Production Deployment

1. Build the application:

```bash
npm run build
```

2. Set production environment variables

3. Run database migrations:

```bash
npm run db:deploy
```

4. Start the server:

```bash
npm run start
```

## 🧹 Development Cleanup

Reset development environment:

```bash
npm run db:seed
```

## 📚 API Documentation

### Public Endpoints

- `GET /api/public/{sellerSlug}/products` - List active products
- `POST /api/public/{sellerSlug}/orders` - Create new order

### Authentication

- `POST /api/auth/login` - Login and get JWT token
- `DELETE /api/auth/login` - Logout
- `GET /api/me` - Get current user info

### Seller Endpoints (Requires Authentication)

- `GET /api/seller/orders` - List orders with pagination
- `GET /api/seller/orders/{id}` - Get order details
- `PATCH /api/seller/orders/{id}/status` - Update order status
- `GET /api/seller/products` - List products
- `POST /api/seller/products` - Create product
- `PATCH /api/seller/products/{id}` - Update product
- `DELETE /api/seller/products/{id}` - Delete product

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm run test`
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.
