export type ImportBalanceRow = {
  row_number: number;
  debit_minor: number;
  credit_minor: number;
  balance_minor: number | null;
};

export type ImportBalanceDiscrepancy = {
  rowNumber: number;
  expectedBalanceMinor: number;
  reportedBalanceMinor: number;
  differenceMinor: number;
};

export type ImportBalanceReport = {
  status: "not_provided" | "matched" | "discrepancy" | "incomplete";
  openingBalanceMinor: number | null;
  calculatedClosingBalanceMinor: number | null;
  reportedClosingBalanceMinor: number | null;
  checkedRows: number;
  missingBalanceRows: number[];
  invalidBalanceRows: number[];
  invalidRows: number[];
  discrepancies: ImportBalanceDiscrepancy[];
};

function sumSafe(values: number[]) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function reconcileImportBalances(
  inputRows: readonly ImportBalanceRow[],
  accountType: string,
): ImportBalanceReport {
  const rows = [...inputRows].sort((a, b) => a.row_number - b.row_number);
  const missingBalanceRows = rows
    .filter((row) => row.balance_minor === null)
    .map((row) => row.row_number);
  const invalidBalanceRows = rows
    .filter((row) => row.balance_minor !== null && !Number.isSafeInteger(row.balance_minor))
    .map((row) => row.row_number);
  const invalidRows: number[] = [];
  const deltas = rows.map((row) => {
    const debit = Number(row.debit_minor);
    const credit = Number(row.credit_minor);
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)
      || debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
      invalidRows.push(row.row_number);
      return null;
    }
    return accountType === "credit_card" || accountType === "loan"
      ? debit - credit
      : credit - debit;
  });
  const balanceRows = rows
    .map((row, index) => ({ row, index, balance: row.balance_minor }))
    .filter((item): item is { row: ImportBalanceRow; index: number; balance: number } =>
      item.balance !== null && Number.isSafeInteger(item.balance));

  if (!balanceRows.length) {
    return {
      status: invalidBalanceRows.length > 0 ? "incomplete" : "not_provided",
      openingBalanceMinor: null,
      calculatedClosingBalanceMinor: null,
      reportedClosingBalanceMinor: null,
      checkedRows: 0,
      missingBalanceRows,
      invalidBalanceRows,
      invalidRows,
      discrepancies: [],
    };
  }

  const firstBalance = balanceRows[0];
  const firstMovements = deltas.slice(0, firstBalance.index + 1);
  const openingMovement = firstMovements.every((delta): delta is number => delta !== null)
    ? sumSafe(firstMovements)
    : null;
  const inferredOpeningBalance = openingMovement === null
    ? null
    : firstBalance.balance - openingMovement;
  const openingBalanceMinor = inferredOpeningBalance !== null && Number.isSafeInteger(inferredOpeningBalance)
    ? inferredOpeningBalance
    : null;
  const allMovements = deltas.every((delta): delta is number => delta !== null)
    ? sumSafe(deltas)
    : null;
  const calculatedClosingBalanceMinor = openingBalanceMinor !== null && allMovements !== null
    && Number.isSafeInteger(openingBalanceMinor + allMovements)
    ? openingBalanceMinor + allMovements
    : null;

  const discrepancies: ImportBalanceDiscrepancy[] = [];
  let checkedRows = 0;
  let previousBalance = firstBalance;
  for (const current of balanceRows.slice(1)) {
    const movements = deltas.slice(previousBalance.index + 1, current.index + 1);
    const movement = movements.every((delta): delta is number => delta !== null)
      ? sumSafe(movements)
      : null;
    if (movement !== null && Number.isSafeInteger(previousBalance.balance + movement)) {
      checkedRows++;
      const expectedBalanceMinor = previousBalance.balance + movement;
      const differenceMinor = expectedBalanceMinor - current.balance;
      if (!Number.isSafeInteger(differenceMinor)) {
        invalidBalanceRows.push(current.row.row_number);
      } else if (expectedBalanceMinor !== current.balance) {
        discrepancies.push({
          rowNumber: current.row.row_number,
          expectedBalanceMinor,
          reportedBalanceMinor: current.balance,
          differenceMinor,
        });
      }
    }
    previousBalance = current;
  }

  const reportedClosingBalanceMinor = rows.length > 0
    && rows[rows.length - 1].balance_minor !== null
    ? rows[rows.length - 1].balance_minor
    : null;
  const status = discrepancies.length > 0
    ? "discrepancy"
    : missingBalanceRows.length > 0 || invalidRows.length > 0 || checkedRows === 0
      || invalidBalanceRows.length > 0 || openingBalanceMinor === null
      || calculatedClosingBalanceMinor === null || reportedClosingBalanceMinor === null
      ? "incomplete"
      : "matched";

  return {
    status,
    openingBalanceMinor,
    calculatedClosingBalanceMinor,
    reportedClosingBalanceMinor,
    checkedRows,
    missingBalanceRows,
    invalidBalanceRows,
    invalidRows,
    discrepancies,
  };
}
