# E-Commerce Order & Payment System

A production-oriented backend project built with **NestJS, TypeScript, PostgreSQL, Prisma, RabbitMQ, and Docker**.

## Features

- JWT authentication with Argon2id password hashing
- Product APIs with pagination
- Concurrency-safe inventory reservation
- Idempotent checkout and order creation
- SSLCommerz sandbox payment integration
- Payment webhook/IPN handling
- Transactional Outbox pattern
- RabbitMQ messaging, retries, and dead-letter handling
- Notification worker with retry and lease recovery
- Health checks and structured request logging
- Prometheus metrics and Grafana-compatible monitoring
- Graceful shutdown and failure recovery

## Tech Stack

- **Backend:** Node.js, TypeScript, NestJS
- **Database:** PostgreSQL, Prisma
- **Messaging:** RabbitMQ
- **Payments:** SSLCommerz Sandbox
- **Authentication:** JWT, Argon2id
- **Monitoring:** Prometheus, Grafana
- **Infrastructure:** Docker, Docker Compose

## Architecture

```text
Client
  |
  v
NestJS API
  |
  +--> PostgreSQL
  |      |
  |      +--> Orders, Payments, Inventory
  |      +--> Transactional Outbox
  |      +--> Notification Jobs
  |
  +--> SSLCommerz Payment Gateway
  |
  +--> RabbitMQ --> Event Consumer

Notification Worker --> SMTP
Prometheus --> Grafana
```

## Getting Started

### Prerequisites

- Node.js and npm
- Docker and Docker Compose
- PostgreSQL and RabbitMQ
- SSLCommerz sandbox credentials for payment testing

### 1. Clone the repository

```bash
git clone <YOUR_REPOSITORY_URL>
cd <YOUR_PROJECT_DIRECTORY>
npm install
```

### 2. Configure environment variables

Create a local `.env` file using the environment variables required by the project.

Configure the database, JWT secret, RabbitMQ, SSLCommerz, SMTP, and public webhook URL as applicable.

**Never commit secrets or your `.env` file.**

### 3. Start infrastructure

```bash
docker compose up -d
```

### 4. Prepare the database

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
```

### 5. Start the application

```bash
npm run start:dev
```

Check the health endpoints:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Adjust the port and commands to match your project configuration.

## Reliability & System Design

This project demonstrates practical backend engineering concepts:

- Atomic database operations to prevent inventory overselling
- Idempotency to handle duplicate checkout requests
- Transactional Outbox for reliable event publishing
- Message acknowledgment, retries, and dead-letter handling
- Payment webhook processing
- Database-backed notification recovery
- Health checks, metrics, and graceful shutdown

The system is designed to handle retries and duplicate events safely. Exactly-once delivery of external side effects, such as email, is not guaranteed.

## Testing

Run the scripts defined in `package.json`. Common commands include:

```bash
npm run build
npm test
```

Important scenarios include concurrent checkout, idempotency conflicts, insufficient inventory, payment callbacks, RabbitMQ recovery, and notification retry behavior.

## Security

- Keep credentials in environment variables or a secret manager.
- Verify payment notifications on the server.
- Validate incoming requests and protect private endpoints.
- Avoid logging sensitive data.
- Use HTTPS for public endpoints.

## Project Goal

The goal of this project is to apply production-oriented backend engineering and system design principles, including reliability, concurrency, asynchronous processing, observability, and failure recovery.
