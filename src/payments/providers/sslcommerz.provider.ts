import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreatePaymentIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  ValidatedTransaction,
} from '../payment-provider.interface.js';

@Injectable()
export class SSLCommerzProvider implements PaymentProvider {
  constructor(private readonly config: ConfigService) {}

  async createIntent(
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    const storeId = this.config.get<string>('SSLCOMMERZ_STORE_ID');
    const storePassword = this.config.get<string>('SSLCOMMERZ_STORE_PASSWORD');
    const baseUrl = this.config.get<string>('SSLCOMMERZ_BASE_URL');
    const publicUrl = this.config.get<string>('APP_PUBLIC_URL');

    if (!storeId || !storePassword || !baseUrl || !publicUrl) {
      throw new InternalServerErrorException(
        'Payment provider configuration is incomplete',
      );
    }

    // Stable transaction ID: retries for the same Payment reuse this ID.
    const tranId = `PAY_${input.paymentId.replaceAll('-', '')}`;

    const form = new URLSearchParams({
      store_id: storeId,
      store_passwd: storePassword,
      total_amount: input.amount,
      currency: input.currency,
      tran_id: tranId,

      success_url: `${publicUrl}/v1/payments/callback/success`,
      fail_url: `${publicUrl}/v1/payments/callback/fail`,
      cancel_url: `${publicUrl}/v1/payments/callback/cancel`,
      ipn_url: `${publicUrl}/v1/payments/webhooks/sslcommerz`,

      // Temporary sandbox customer details.
      // Replace these with validated customer/profile data before production.
      cus_name: 'Test Customer',
      cus_email: input.customerEmail,
      cus_add1: 'Dhaka',
      cus_city: 'Dhaka',
      cus_postcode: '1000',
      cus_country: 'Bangladesh',
      cus_phone: '01700000000',

      shipping_method: 'NO',
      product_name: 'E-commerce Order',
      product_category: 'General',
      product_profile: 'general',
    });

    let response: Response;

    try {
      response = await fetch(`${baseUrl}/gwprocess/v4/api.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Payment provider is temporarily unavailable',
      );
    }

    if (!response.ok) {
      throw new BadGatewayException(
        'Payment provider returned an unsuccessful response',
      );
    }

    let result: {
      status?: string;
      failedreason?: string;
      GatewayPageURL?: string;
      sessionkey?: string;
    };

    try {
      result = await response.json();
    } catch {
      throw new BadGatewayException(
        'Payment provider returned an invalid response',
      );
    }

    if (
      result.status !== 'SUCCESS' ||
      !result.GatewayPageURL ||
      !result.sessionkey
    ) {
      // Do not expose provider credentials or raw response to the client.
      throw new BadGatewayException(
        'Unable to create a payment checkout session',
      );
    }

    // Only allow HTTPS checkout URLs from the expected provider host.
    const checkoutUrl = new URL(result.GatewayPageURL);
    const expectedHost = new URL(baseUrl).hostname;

    if (
      checkoutUrl.protocol !== 'https:' ||
      checkoutUrl.hostname !== expectedHost
    ) {
      throw new BadGatewayException(
        'Payment provider returned an unexpected checkout URL',
      );
    }

    return {
      providerReference: tranId,
      checkoutUrl: result.GatewayPageURL,
      sessionKey: result.sessionkey,
    };
  }

  async validateTransaction(valId: string): Promise<ValidatedTransaction> {
    const storeId = this.config.get<string>('SSLCOMMERZ_STORE_ID');
    const storePassword = this.config.get<string>('SSLCOMMERZ_STORE_PASSWORD');
    const baseUrl = this.config.get<string>('SSLCOMMERZ_BASE_URL');

    if (!storeId || !storePassword || !baseUrl) {
      throw new InternalServerErrorException(
        'Payment provider configuration is incomplete',
      );
    }

    if (!valId || valId.length > 50) {
      throw new BadRequestException('Invalid validation ID');
    }

    const url = new URL('/validator/api/validationserverAPI.php', baseUrl);

    url.searchParams.set('val_id', valId);
    url.searchParams.set('store_id', storeId);
    url.searchParams.set('store_passwd', storePassword);
    url.searchParams.set('format', 'json');

    let response: Response;

    try {
      response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Unable to reach payment validation service',
      );
    }

    if (!response.ok) {
      throw new BadGatewayException(
        'Payment validation service returned an error',
      );
    }

    const result = await response.json();

    if (
      typeof result.status !== 'string' ||
      typeof result.tran_id !== 'string' ||
      typeof result.val_id !== 'string' ||
      typeof result.amount !== 'string'
    ) {
      throw new BadGatewayException('Invalid payment validation response');
    }

    return result as ValidatedTransaction;
  }
}
