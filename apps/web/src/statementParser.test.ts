import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parsePdfLines, parseStatementFile } from "./statementParser.js";

function makeFile(name: string, value: string | Uint8Array): File {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return {
    name,
    size: bytes.byteLength,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as File;
}

describe("statement import parsers", () => {
  it("normalizes CSV debit/credit rows and preserves invalid dates for review", async () => {
    const file = makeFile(
      "statement.csv",
      "Transaction Date,Narration,Debit,Credit\n23/11/2026,Groceries,125.00,\nnot-a-date,Unclear row,20.00,",
    );
    const result = await parseStatementFile(file);
    expect(result.fileType).toBe("csv");
    expect(result.rows).toEqual([
      { rowNumber: 2, description: "Groceries", transactionDate: "23/11/2026", debitMinor: 12500, creditMinor: 0 },
      { rowNumber: 3, description: "Unclear row", transactionDate: "not-a-date", debitMinor: 2000, creditMinor: 0 },
    ]);
  });

  it("preserves signed numeric balances from spreadsheet columns", async () => {
    const result = await parseStatementFile(makeFile(
      "statement.csv",
      'Date,Description,Debit,Credit,Balance\n23/11/2026,Overdraft fee,100.00,,"(1,875.25)"',
    ));

    expect(result.rows[0]).toMatchObject({
      debitMinor: 10000,
      creditMinor: 0,
      balanceMinor: -187525,
    });
  });

  it.each(["xls", "xlsx"] as const)("reads %s worksheets", async (extension) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Transaction Date", "Description", "Debit", "Credit"],
      ["23/11/2026", "Grocery", 150.25, ""],
    ]), "Statement");
    const bytes = XLSX.write(workbook, { type: "array", bookType: extension });
    const result = await parseStatementFile(makeFile(`statement.${extension}`, new Uint8Array(bytes)));
    expect(result.fileType).toBe(extension);
    expect(result.rows).toContainEqual(expect.objectContaining({
      description: "Grocery",
      debitMinor: 15025,
      creditMinor: 0,
    }));
  });

  it("classifies PDF table values by debit/credit column position", () => {
    const result = parsePdfLines([
      [{ text: "Date", x: 50, y: 700 }, { text: "Description", x: 125, y: 700 }, { text: "Debit", x: 280, y: 700 }, { text: "Credit", x: 380, y: 700 }],
      [{ text: "23/11/2026", x: 50, y: 680 }, { text: "Grocery", x: 125, y: 680 }, { text: "125.00", x: 280, y: 680 }],
    ]);
    expect(result).toContainEqual(expect.objectContaining({
      description: "Grocery",
      transactionDate: "23/11/2026",
      debitMinor: 12500,
      creditMinor: 0,
    }));
  });

  it("extracts a running balance from a PDF balance column", () => {
    const result = parsePdfLines([
      [
        { text: "Date", x: 50, y: 700 },
        { text: "Description", x: 125, y: 700 },
        { text: "Debit", x: 280, y: 700 },
        { text: "Credit", x: 380, y: 700 },
        { text: "Balance", x: 480, y: 700 },
      ],
      [
        { text: "23/11/2026", x: 50, y: 680 },
        { text: "Grocery", x: 125, y: 680 },
        { text: "125.00", x: 280, y: 680 },
        { text: "8,750.00", x: 480, y: 680 },
      ],
    ]);

    expect(result[0]).toMatchObject({ debitMinor: 12500, balanceMinor: 875000 });
  });

  it("rejects ambiguous PDF money direction rather than guessing", () => {
    expect(() => parsePdfLines([
      [{ text: "Date", x: 50, y: 700 }, { text: "Description", x: 125, y: 700 }],
      [{ text: "23/11/2026", x: 50, y: 680 }, { text: "Grocery", x: 125, y: 680 }, { text: "125.00", x: 280, y: 680 }],
    ])).toThrow(/Could not determine whether PDF row/);
  });
});
