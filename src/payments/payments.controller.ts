import {
  Controller,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PaymentsService } from './payments.service.js';

type AuthenticatedRequest = Request & {
  user: { id: string; role: 'CUSTOMER' | 'ADMIN' };
};

@Controller('v1/orders/:orderId/payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  createIntent(
    @Req() request: AuthenticatedRequest,
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.payments.createIntent(request.user.id, orderId, key);
  }
}
