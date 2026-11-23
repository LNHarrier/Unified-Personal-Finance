export class AccountingValidationError extends Error {}

export interface JournalLineInput {
  ledgerAccountId: string;
  debitMinor: bigint;
  creditMinor: bigint;
  description?: string;
}

export function validateJournalLines(lines: JournalLineInput[]): void {
  if (lines.length === 0) throw new AccountingValidationError("A journal entry must contain lines.");

  let debitTotal = 0n;
  let creditTotal = 0n;

  for (const line of lines) {
    if (line.debitMinor < 0n || line.creditMinor < 0n) {
      throw new AccountingValidationError("Journal line amounts must be non-negative.");
    }
    if ((line.debitMinor > 0n) === (line.creditMinor > 0n)) {
      throw new AccountingValidationError(
        "A journal line must contain either a debit or a credit.",
      );
    }
    debitTotal += line.debitMinor;
    creditTotal += line.creditMinor;
  }

  if (debitTotal !== creditTotal) {
    throw new AccountingValidationError("Posted debit total must equal posted credit total.");
  }
}
