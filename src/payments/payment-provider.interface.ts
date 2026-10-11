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

export interface ValidatedTransaction {
  status: string;
  tran_id: string;
  val_id: string;
  amount: string;
  currency?: string;
  currency_type?: string;
}

export interface ProviderTransactionStatus {
  status: string;
  tran_id: string;
  val_id?: string;
  amount?: string;
  currency_type?: string;
}

export interface PaymentProvider {
  createIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;

  validateTransaction(valId: string): Promise<ValidatedTransaction>;

  queryTransaction(tranId: string): Promise<ProviderTransactionStatus>;
}
