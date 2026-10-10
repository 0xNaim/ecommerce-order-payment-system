import {
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrdersService } from './orders.service.js';

type AuthenticatedRequest = Request & {
  user: { id: string; role: 'CUSTOMER' | 'ADMIN' };
};

@Controller('v1/orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.createOrder(request.user.id, key, dto);
  }
}
