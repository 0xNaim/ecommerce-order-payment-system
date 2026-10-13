import 'dotenv/config';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/auth/auth.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Auth integration tests', () => {
  let prisma: PrismaService;
  let authService: AuthService;
  let jwtService: JwtService;

  const runId = randomUUID();
  const emailPrefix = `auth-it-${runId}-`;
  const password = 'StrongPassword123!';

  beforeAll(async () => {
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error(
        'JWT_SECRET must be configured with at least 32 characters for tests',
      );
    }

    prisma = new PrismaService();
    await prisma.$connect();

    jwtService = new JwtService({
      secret: jwtSecret,
      signOptions: {
        algorithm: 'HS256',
        expiresIn: 900,
      },
    });

    const configService = new ConfigService({
      JWT_SECRET: jwtSecret,
    });

    authService = new AuthService(prisma, jwtService, configService);
  });

  afterAll(async () => {
    if (!prisma) return;

    await prisma.user.deleteMany({
      where: {
        email: {
          startsWith: emailPrefix,
        },
      },
    });

    await prisma.$disconnect();
  });

  async function registerUser(email: string) {
    return authService.register({
      email,
      password,
    });
  }

  it('registers a user with a hashed password and never returns the hash', async () => {
    const email = `${emailPrefix}register@example.com`;

    const response = await registerUser(email);

    expect(response).toMatchObject({
      email,
      role: 'CUSTOMER',
    });
    expect(response).toHaveProperty('id');
    expect(response).toHaveProperty('createdAt');
    expect(response).not.toHaveProperty('password');
    expect(response).not.toHaveProperty('passwordHash');

    const savedUser = await prisma.user.findUniqueOrThrow({
      where: { email },
    });

    expect(savedUser.passwordHash).not.toBe(password);
    expect(await argon2.verify(savedUser.passwordHash, password)).toBe(true);
  });

  it('normalizes email addresses during registration', async () => {
    const email = `${emailPrefix}normalize@example.com`;

    await registerUser(`  ${email.toUpperCase()}  `);

    const savedUser = await prisma.user.findUnique({
      where: { email },
    });

    expect(savedUser).not.toBeNull();
    expect(savedUser?.email).toBe(email);
  });

  it('rejects duplicate email registration with ConflictException', async () => {
    const email = `${emailPrefix}duplicate@example.com`;

    await registerUser(email);

    await expect(registerUser(email)).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs in with valid credentials and returns a verifiable JWT', async () => {
    const email = `${emailPrefix}login@example.com`;

    await registerUser(email);

    const response = await authService.login({
      email,
      password,
    });

    expect(response.tokenType).toBe('Bearer');
    expect(response.expiresIn).toBe(900);
    expect(response.accessToken).toEqual(expect.any(String));

    const payload = await jwtService.verifyAsync(response.accessToken, {
      algorithms: ['HS256'],
    });

    const savedUser = await prisma.user.findUniqueOrThrow({
      where: { email },
    });

    expect(payload.sub).toBe(savedUser.id);
    expect(payload.role).toBe('CUSTOMER');
  });

  it('normalizes email addresses during login', async () => {
    const email = `${emailPrefix}login-normalize@example.com`;

    await registerUser(email);

    const response = await authService.login({
      email: `  ${email.toUpperCase()}  `,
      password,
    });

    expect(response.accessToken).toEqual(expect.any(String));
  });

  it('rejects an incorrect password with UnauthorizedException', async () => {
    const email = `${emailPrefix}wrong-password@example.com`;

    await registerUser(email);

    await expect(
      authService.login({
        email,
        password: 'WrongPassword123!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects login for an unknown email with UnauthorizedException', async () => {
    await expect(
      authService.login({
        email: `${emailPrefix}unknown@example.com`,
        password,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
