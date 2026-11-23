import * as XLSX from "xlsx";

export type ParsedStatementRow = {
  rowNumber: number;
  description: string;
  transactionDate: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor?: number;
  externalReference?: string;
};

const PDF_DATE_START = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/;
const PDF_MONEY = /^(?:₹|INR\s*|Rs\.?\s*)?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?\s*(?:DR|CR)?$/i;

function parseMinor(value: unknown): number {
  const text = String(value ?? "").trim();
  const numeric = Number(text.replace(/[₹,\s]|INR|Rs\.?/gi, "").replace(/[()]/g, ""));
  return Number.isFinite(numeric) ? Math.round(Math.abs(numeric) * 100) : 0;
}

function parseBalanceMinor(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const amountText = text.replace(/^(?:₹|INR\s*|Rs\.?\s*)/i, "").replace(/,/g, "").trim();
  const parentheses = amountText.match(/^\((.+)\)$/);
  const signedText = parentheses ? `-${parentheses[1]}` : amountText;
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(signedText)) {
    throw new Error(`Unsupported statement balance "${text}". Use a signed numeric balance value.`);
  }
  const balanceMinor = Math.round(Number(signedText) * 100);
  if (!Number.isSafeInteger(balanceMinor)) throw new Error(`Statement balance "${text}" is outside the supported range.`);
  return balanceMinor;
}

function normalizeTable(input: unknown[][]): ParsedStatementRow[] {
  const table = input.map((row) => row.map((value) => String(value ?? "").trim()));
  let headerRowIndex = -1;
  let dateIndex = -1;
  let descriptionIndex = -1;
  let debitIndex = -1;
  let creditIndex = -1;
  let amountIndex = -1;
  let balanceIndex = -1;
  let referenceIndex = -1;

  for (let index = 0; index < Math.min(table.length, 20); index++) {
    const headers = table[index].map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
    const find = (patterns: string[]) => headers.findIndex((header) =>
      patterns.some((pattern) => header === pattern || header.includes(pattern)));
    const candidateDate = find(["date", "transaction date", "txn date", "value date", "posting date"]);
    const candidateDescription = find(["description", "narration", "details", "merchant", "particulars"]);
    const candidateDebit = find(["debit", "withdrawal", "paid"]);
    const candidateCredit = find(["credit", "deposit", "received"]);
    const candidateAmount = find(["amount", "value"]);
    const candidateBalance = headers.findIndex((header) =>
      !header.includes("opening")
      && (header === "balance" || header.startsWith("balance ") || header.includes("running balance") || header.includes("closing balance")));
    if (candidateDate >= 0 && candidateDescription >= 0
      && (candidateDebit >= 0 || candidateCredit >= 0 || candidateAmount >= 0)) {
      headerRowIndex = index;
      dateIndex = candidateDate;
      descriptionIndex = candidateDescription;
      debitIndex = candidateDebit;
      creditIndex = candidateCredit;
      amountIndex = candidateAmount;
      balanceIndex = candidateBalance;
      referenceIndex = find(["reference", "transaction id", "reference number", "utr"]);
      break;
    }
  }
  if (headerRowIndex < 0) {
    throw new Error("Statement needs date, description, and debit/credit or amount columns.");
  }

  const result: ParsedStatementRow[] = [];
  for (let index = headerRowIndex + 1; index < table.length; index++) {
    const cells = table[index];
    const date = cells[dateIndex] ?? "";
    const description = cells[descriptionIndex] ?? "";
    if (!date && !description && cells.every((cell) => !cell)) continue;
    let debitMinor = debitIndex < 0 ? 0 : parseMinor(cells[debitIndex]);
    let creditMinor = creditIndex < 0 ? 0 : parseMinor(cells[creditIndex]);
    const balanceMinor = balanceIndex < 0 ? undefined : parseBalanceMinor(cells[balanceIndex] ?? "");
    if (debitIndex < 0 && creditIndex < 0 && cells[amountIndex]) {
      const signedAmount = Number(String(cells[amountIndex]).replace(/[₹,\s]|INR|Rs\.?/gi, ""));
      if (Number.isFinite(signedAmount)) {
        debitMinor = signedAmount < 0 ? parseMinor(cells[amountIndex]) : 0;
        creditMinor = signedAmount > 0 ? parseMinor(cells[amountIndex]) : 0;
      }
    }
    result.push({
      rowNumber: index + 1,
      description,
      transactionDate: date,
      debitMinor,
      creditMinor,
      ...(balanceMinor !== undefined ? { balanceMinor } : {}),
      ...(referenceIndex >= 0 && cells[referenceIndex] ? { externalReference: cells[referenceIndex] } : {}),
    });
  }
  if (!result.length) throw new Error("No dated transaction rows were found below the statement header.");
  return result;
}

type PdfTextLine = Array<{ text: string; x: number; y: number }>;

export function parsePdfLines(lines: PdfTextLine[], startingRowNumber = 0): ParsedStatementRow[] {
  const headerItems = lines.flat().map((item) => ({ ...item, normalized: item.text.toLowerCase() }));
  const debitHeaders = headerItems.filter((item) => /\b(debit|withdrawal|paid|dr)\b/.test(item.normalized));
  const creditHeaders = headerItems.filter((item) => /\b(credit|deposit|received|cr)\b/.test(item.normalized));
  const balanceHeaders = headerItems.filter((item) =>
    /\b(balance|closing)\b/.test(item.normalized) && !/\bopening\b/.test(item.normalized));
  const debitX = debitHeaders[0]?.x;
  const creditX = creditHeaders[0]?.x;
  const balanceX = balanceHeaders[0]?.x;
  const dateAndAmountRows = lines.map((items) => ({
    items,
    text: items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim(),
  })).filter((line) => PDF_DATE_START.test(line.text));
  const result: ParsedStatementRow[] = [];
  let rowNumber = startingRowNumber;

  for (const line of dateAndAmountRows) {
    rowNumber++;
    const dateMatch = line.text.match(PDF_DATE_START);
    if (!dateMatch) continue;
    const date = dateMatch[1];
    const lower = line.text.toLowerCase();
    if (/\b(failed|declined|pending|reversed)\b/.test(lower)) continue;
    const values = line.items.filter((item) => PDF_MONEY.test(item.text));
    const columnPositionsAvailable = debitX !== undefined && creditX !== undefined;
    const balanceValue = !columnPositionsAvailable || balanceX === undefined ? undefined : values.find((item) =>
      Math.abs(item.x - balanceX) < Math.min(
        Math.abs(item.x - debitX),
        Math.abs(item.x - creditX),
      ));
    const balanceMinor = balanceValue ? parseBalanceMinor(balanceValue.text) : undefined;
    const transactionValues = balanceValue ? values.filter((item) => item !== balanceValue) : values;
    let debitMinor = 0;
    let creditMinor = 0;
    let amountTexts: string[] = [];

    if (columnPositionsAvailable) {
      for (const value of transactionValues) {
        if (balanceX !== undefined && Math.abs(value.x - balanceX) < Math.min(
          Math.abs(value.x - debitX!),
          Math.abs(value.x - creditX!),
        )) continue;
        if (Math.abs(value.x - debitX!) <= Math.abs(value.x - creditX!)) debitMinor += parseMinor(value.text);
        else creditMinor += parseMinor(value.text);
        amountTexts.push(value.text);
      }
    }

    const directionIsDebit = /\b(debit|withdrawal|paid|sent|purchase|dr|debited)\b/.test(lower);
    const directionIsCredit = /\b(credit|deposit|received|cr|credited|refund)\b/.test(lower);
    if (!debitMinor && !creditMinor && transactionValues.length && directionIsDebit !== directionIsCredit) {
      const amountText = transactionValues[transactionValues.length - 1].text;
      if (directionIsDebit) debitMinor = parseMinor(amountText);
      else creditMinor = parseMinor(amountText);
      amountTexts = [amountText];
    }
    if ((debitMinor > 0) === (creditMinor > 0)) {
      throw new Error(`Could not determine whether PDF row ${rowNumber} is a debit or credit. Use a PDF with Debit/Credit columns or import an XLSX/CSV statement.`);
    }

    const description = line.text
      .replace(dateMatch[0], "")
      .replace(new RegExp(amountTexts.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi"), "")
      .replace(/\b(debit|withdrawal|paid|sent|purchase|dr|debited|credit|deposit|received|cr|credited|refund)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!description) throw new Error(`PDF transaction row ${rowNumber} has no description.`);
    result.push({
      rowNumber,
      description,
      transactionDate: date,
      debitMinor,
      creditMinor,
      ...(balanceMinor !== undefined ? { balanceMinor } : {}),
    });
  }
  return result;
}

async function parsePdf(file: File): Promise<ParsedStatementRow[]> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (document.numPages > 100) throw new Error("PDF statements are limited to 100 pages.");
  const extractedRows: ParsedStatementRow[] = [];
  let rowNumber = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const textItems = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      "str" in item && "transform" in item);
    const lines: Array<Array<{ text: string; x: number; y: number }>> = [];
    for (const item of textItems) {
      const text = item.str.trim();
      if (!text) continue;
      const x = item.transform[4] ?? 0;
      const y = item.transform[5] ?? 0;
      let line = lines.find((candidate) => Math.abs(candidate[0].y - y) < 2.5);
      if (!line) {
        line = [];
        lines.push(line);
      }
      line.push({ text, x, y });
    }
    for (const line of lines) line.sort((a, b) => a.x - b.x);
    lines.sort((a, b) => b[0].y - a[0].y);
    const dateRowCount = lines.filter((items) =>
      PDF_DATE_START.test(items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim())).length;
    extractedRows.push(...parsePdfLines(lines,rowNumber));
    rowNumber += dateRowCount;
  }
  if (!extractedRows.length) {
    throw new Error("No selectable-text transactions were found. Scanned PDFs require OCR and are not supported.");
  }
  return extractedRows;
}

export async function parseStatementFile(file: File): Promise<{
  fileType: "csv" | "xls" | "xlsx" | "pdf";
  rows: ParsedStatementRow[];
}> {
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "pdf") return { fileType: "pdf", rows: await parsePdf(file) };
  if (extension !== "csv" && extension !== "xls" && extension !== "xlsx") {
    throw new Error("Choose a CSV, XLS, XLSX, or PDF file.");
  }
  if (extension === "csv") {
    const text = await file.text();
    const rows = parseCsv(text);
    return { fileType: "csv", rows: normalizeTable(rows) };
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: false, cellDates: false });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("The workbook does not contain a worksheet.");
  const worksheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: "" });
  return { fileType: extension, rows: normalizeTable(rows) };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
