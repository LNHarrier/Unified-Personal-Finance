export type LedgerAccountClass =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense";

export interface JournalLineInput {
  ledgerAccountId: string;
  debitMinor: bigint;
  creditMinor: bigint;
  description?: string;
}
