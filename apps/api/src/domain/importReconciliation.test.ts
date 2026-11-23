import { describe, expect, it } from "vitest";
import { reconcileImportBalances } from "./importReconciliation.js";

describe("import balance reconciliation", () => {
  it("checks a bank statement balance chain and infers opening and closing balances", () => {
    const report = reconcileImportBalances([
      { row_number: 2, debit_minor: 12500, credit_minor: 0, balance_minor: 87500 },
      { row_number: 3, debit_minor: 0, credit_minor: 5000, balance_minor: 92500 },
    ], "bank");

    expect(report).toMatchObject({
      status: "matched",
      openingBalanceMinor: 100000,
      calculatedClosingBalanceMinor: 92500,
      reportedClosingBalanceMinor: 92500,
      checkedRows: 1,
      discrepancies: [],
    });
  });

  it("reports a mismatch instead of adjusting the statement balance", () => {
    const report = reconcileImportBalances([
      { row_number: 2, debit_minor: 12500, credit_minor: 0, balance_minor: 87500 },
      { row_number: 3, debit_minor: 0, credit_minor: 5000, balance_minor: 93500 },
    ], "bank");

    expect(report.status).toBe("discrepancy");
    expect(report.discrepancies).toEqual([{
      rowNumber: 3,
      expectedBalanceMinor: 92500,
      reportedBalanceMinor: 93500,
      differenceMinor: -1000,
    }]);
  });

  it("uses liability balance direction for credit card statements", () => {
    const report = reconcileImportBalances([
      { row_number: 2, debit_minor: 10000, credit_minor: 0, balance_minor: 60000 },
      { row_number: 3, debit_minor: 0, credit_minor: 25000, balance_minor: 35000 },
    ], "credit_card");

    expect(report).toMatchObject({
      status: "matched",
      openingBalanceMinor: 50000,
      calculatedClosingBalanceMinor: 35000,
    });
  });

  it("marks missing balance or invalid transaction rows as incomplete", () => {
    const report = reconcileImportBalances([
      { row_number: 2, debit_minor: 1000, credit_minor: 0, balance_minor: 9000 },
      { row_number: 3, debit_minor: 0, credit_minor: 0, balance_minor: 9000 },
    ], "bank");

    expect(report.status).toBe("incomplete");
    expect(report.invalidRows).toEqual([3]);
    expect(report.missingBalanceRows).toEqual([]);
  });

  it("marks balances outside JavaScript's safe integer range as incomplete", () => {
    const report = reconcileImportBalances([
      { row_number: 2, debit_minor: 1000, credit_minor: 0, balance_minor: Number.MAX_SAFE_INTEGER + 1 },
      { row_number: 3, debit_minor: 1000, credit_minor: 0, balance_minor: 8000 },
    ], "bank");

    expect(report.status).toBe("incomplete");
    expect(report.invalidBalanceRows).toEqual([2]);
  });
});
