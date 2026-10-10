import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { PaymentsService } from './payments.service.js';

@Controller('v1/payments/webhooks')
export class PaymentWebhooksController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('sslcommerz')
  @HttpCode(HttpStatus.OK)
  async handleSSLCommerzWebhook(@Body() body: Record<string, unknown>) {
    const tranId = typeof body.tran_id === 'string' ? body.tran_id : '';
    const valId = typeof body.val_id === 'string' ? body.val_id : '';

    if (!tranId || !valId) {
      throw new BadRequestException('Missing transaction or validation ID');
    }

    return this.paymentsService.confirmPayment({
      tranId,
      valId,
      payload: body,
    });
  }
}
