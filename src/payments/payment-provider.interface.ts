export interface CreatePaymentIntentInput {
  paymentId: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
}

export interface PaymentIntentResult {
  providerReference: string;
  checkoutUrl?: string;
}

export interface PaymentProvider {
  createIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;
}
