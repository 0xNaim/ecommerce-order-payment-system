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
    const status = typeof body.status === 'string' ? body.status : '';

    if (!tranId || !status) {
      throw new BadRequestException('Missing transaction ID or status');
    }

    if (status === 'VALID' || status === 'VALIDATED') {
      const valId = typeof body.val_id === 'string' ? body.val_id : '';

      if (!valId) {
        throw new BadRequestException('Missing validation ID');
      }

      return this.paymentsService.confirmPayment({
        tranId,
        valId,
        payload: body,
      });
    }

    if (['FAILED', 'CANCELLED', 'EXPIRED', 'UNATTEMPTED'].includes(status)) {
      return this.paymentsService.handleFailureNotification({
        tranId,
        ipnStatus: status,
        payload: body,
      });
    }

    // Unknown status: acknowledge receipt without changing money or stock.
    return {
      received: true,
      pendingReconciliation: true,
    };
  }
}
