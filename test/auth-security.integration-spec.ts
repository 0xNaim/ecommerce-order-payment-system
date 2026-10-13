import { jest } from '@jest/globals';
import {
  Controller,
  Get,
  INestApplication,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import 'reflect-metadata';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';

const JWT_SECRET =
  'integration-test-secret-that-is-at-least-32-characters-long';

@Controller('v1/test-protected')
@UseGuards(JwtAuthGuard)
class TestProtectedController {
  @Get()
  getProtectedResource(@Req() req: { user: { id: string; role: string } }) {
    return { user: req.user };
  }
}

describe('Authentication security integration tests', () => {
  let app: INestApplication;
  let jwt: JwtService;

  const authMock = {
    register: jest.fn<(dto: unknown) => Promise<unknown>>(),
    login: jest.fn<(dto: unknown) => Promise<unknown>>(),
  };

  beforeAll(async () => {
    jwt = new JwtService({
      secret: JWT_SECRET,
      signOptions: {
        algorithm: 'HS256',
        expiresIn: 900,
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, TestProtectedController],
      providers: [
        JwtAuthGuard,
        {
          provide: AuthService,
          useValue: authMock,
        },
        {
          provide: JwtService,
          useValue: jwt,
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              if (key !== 'JWT_SECRET') {
                throw new Error(`Unexpected config key: ${key}`);
              }

              return JWT_SECRET;
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    authMock.register.mockReset();
    authMock.login.mockReset();

    authMock.register.mockResolvedValue({
      id: 'test-user-id',
      email: 'customer@example.com',
      role: 'CUSTOMER',
      createdAt: new Date(),
    });

    authMock.login.mockResolvedValue({
      accessToken: 'mock-access-token',
      tokenType: 'Bearer',
      expiresIn: 900,
    });
  });

  describe('HTTP DTO validation', () => {
    it('rejects an invalid registration email', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: 'not-an-email',
          password: 'StrongPassword123!',
        });

      expect(response.status).toBe(400);
      expect(authMock.register).not.toHaveBeenCalled();
    });

    it('rejects a registration password shorter than 12 characters', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: 'customer@example.com',
          password: 'short',
        });

      expect(response.status).toBe(400);
      expect(authMock.register).not.toHaveBeenCalled();
    });

    it('rejects a missing registration password', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: 'customer@example.com',
        });

      expect(response.status).toBe(400);
      expect(authMock.register).not.toHaveBeenCalled();
    });

    it('rejects unexpected registration properties', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: 'customer@example.com',
          password: 'StrongPassword123!',
          role: 'ADMIN',
        });

      expect(response.status).toBe(400);
      expect(authMock.register).not.toHaveBeenCalled();
    });

    it('rejects an invalid login email', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          email: 'invalid-email',
          password: 'StrongPassword123!',
        });

      expect(response.status).toBe(400);
      expect(authMock.login).not.toHaveBeenCalled();
    });

    it('rejects a missing login password', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          email: 'customer@example.com',
        });

      expect(response.status).toBe(400);
      expect(authMock.login).not.toHaveBeenCalled();
    });

    it('accepts a valid registration DTO', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: 'customer@example.com',
          password: 'StrongPassword123!',
        });

      expect(response.status).toBe(201);
      expect(authMock.register).toHaveBeenCalledWith({
        email: 'customer@example.com',
        password: 'StrongPassword123!',
      });
    });

    it('accepts a valid login DTO', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          email: 'customer@example.com',
          password: 'StrongPassword123!',
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
      });
      expect(authMock.login).toHaveBeenCalled();
    });
  });

  describe('JWT guard', () => {
    it('allows a request with a valid CUSTOMER token', async () => {
      const token = await jwt.signAsync({
        sub: 'customer-123',
        role: 'CUSTOMER',
      });

      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        user: {
          id: 'customer-123',
          role: 'CUSTOMER',
        },
      });
    });

    it('allows a request with a valid ADMIN token', async () => {
      const token = await jwt.signAsync({
        sub: 'admin-123',
        role: 'ADMIN',
      });

      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.user.role).toBe('ADMIN');
    });

    it('rejects a missing Authorization header', async () => {
      const response = await request(app.getHttpServer()).get(
        '/v1/test-protected',
      );

      expect(response.status).toBe(401);
    });

    it('rejects a malformed Bearer header', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', 'BearerXYZ');

      expect(response.status).toBe(401);
    });

    it('rejects an invalid token', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', 'Bearer invalid.token.value');

      expect(response.status).toBe(401);
    });

    it('rejects an expired token', async () => {
      const token = await jwt.signAsync(
        {
          sub: 'customer-123',
          role: 'CUSTOMER',
        },
        { expiresIn: -1 },
      );

      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
    });

    it('rejects a token signed using HS384', async () => {
      const token = await jwt.signAsync(
        {
          sub: 'customer-123',
          role: 'CUSTOMER',
        },
        { algorithm: 'HS384' },
      );

      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
    });

    it('rejects a token without a string subject', async () => {
      const token = await jwt.signAsync({
        sub: 123,
        role: 'CUSTOMER',
      } as never);

      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
    });

    it('rejects a token with an unsupported role', async () => {
      const token = await jwt.signAsync({
        sub: 'user-123',
        role: 'SUPERADMIN',
      });

      const response = await request(app.getHttpServer())
        .get('/v1/test-protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
    });
  });
});
