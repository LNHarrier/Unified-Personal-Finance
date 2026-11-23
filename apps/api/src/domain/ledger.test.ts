import { describe, expect, it } from "vitest";
import { AccountingValidationError, validateJournalLines } from "./ledger.js";

describe("ledger posting validation", () => {
  it("accepts a balanced journal", () => {
    expect(() => validateJournalLines([
      { ledgerAccountId: "asset", debitMinor: 500000n, creditMinor: 0n },
      { ledgerAccountId: "income", debitMinor: 0n, creditMinor: 500000n },
    ])).not.toThrow();
  });

  it("rejects an unbalanced journal", () => {
    expect(() => validateJournalLines([
      { ledgerAccountId: "asset", debitMinor: 100000n, creditMinor: 0n },
      { ledgerAccountId: "income", debitMinor: 0n, creditMinor: 90000n },
    ])).toThrow(AccountingValidationError);
  });

  it("rejects a line containing both debit and credit", () => {
    expect(() => validateJournalLines([
      { ledgerAccountId: "asset", debitMinor: 100n, creditMinor: 100n },
    ])).toThrow(AccountingValidationError);
  });

  it("rejects a negative line amount", () => {
    expect(() => validateJournalLines([
      { ledgerAccountId: "asset", debitMinor: -1n, creditMinor: 0n },
    ])).toThrow(AccountingValidationError);
  });
});
