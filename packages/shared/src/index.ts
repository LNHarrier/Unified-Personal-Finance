export type AccountType =
  | "bank"
  | "cash"
  | "credit_card"
  | "loan"
  | "investment";

export interface ErrorResponse {
  code: string;
  message: string;
  requestId: string;
}
