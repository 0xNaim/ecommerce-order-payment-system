export interface CreatePaymentIntentInput {
  paymentId: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
  customerEmail: string;
}

export interface PaymentIntentResult {
  providerReference: string;
  checkoutUrl: string;
  sessionKey: string;
}

export interface PaymentProvider {
  createIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;
}
