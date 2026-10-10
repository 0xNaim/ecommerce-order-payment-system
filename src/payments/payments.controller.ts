import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
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
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  createIntent(
    @Req() request: AuthenticatedRequest,
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.paymentsService.createIntent(request.user.id, orderId, key);
  }

  @Post('webhooks/sslcommerz')
  @HttpCode(HttpStatus.OK)
  async handleSSLCommerzWebhook(@Body() body: Record<string, unknown>) {
    const tranId = typeof body.tran_id === 'string' ? body.tran_id : '';
    const valId = typeof body.val_id === 'string' ? body.val_id : '';

    if (!tranId || !valId) {
      throw new BadRequestException('Missing transaction or validation ID');
    }

    await this.paymentsService.confirmPayment({ tranId, valId, payload: body });

    return { received: true };
  }
}
