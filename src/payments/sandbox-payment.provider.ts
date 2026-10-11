import { createHash } from 'crypto';
import {
  CreatePaymentIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  ProviderTransactionStatus,
  ValidatedTransaction,
} from './payment-provider.interface.js';

export class SandboxPaymentProvider implements PaymentProvider {
  async createIntent(
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    const reference = createHash('sha256')
      .update(input.idempotencyKey)
      .digest('hex')
      .slice(0, 32);

    const providerReference = `sandbox_${reference}`;

    return {
      providerReference,
      checkoutUrl: `https://sandbox.invalid/checkout/${providerReference}`,
      sessionKey: providerReference,
    };
  }

  async validateTransaction(_valId: string): Promise<ValidatedTransaction> {
    throw new Error(
      'Sandbox payment provider cannot validate transactions; use the SSLCommerz provider',
    );
  }

  async queryTransaction(_tranId: string): Promise<ProviderTransactionStatus> {
    throw new Error(
      'Sandbox payment provider cannot query transactions; use the SSLCommerz provider',
    );
  }
}
