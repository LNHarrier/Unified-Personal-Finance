import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import bcrypt from "bcryptjs";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db/client.js";
import { authenticate, createSession } from "./auth.js";
import { config } from "./config.js";
import { AccountingValidationError, validateJournalLines } from "./domain/ledger.js";
import { reconcileImportBalances } from "./domain/importReconciliation.js";

const defaultCategories = [
  ["Salary", "income"], ["Business income", "income"], ["Interest", "income"],
  ["Rental income", "income"], ["Other income", "income"],
  ["Rent", "expense"], ["Utilities", "expense"], ["Groceries", "expense"],
  ["Restaurants", "expense"], ["Transport", "expense"], ["Shopping", "expense"],
  ["Health", "expense"], ["Insurance", "expense"], ["Entertainment", "expense"],
  ["Travel", "expense"], ["Subscriptions", "expense"], ["Other", "expense"],
] as const;

function parseImportDate(value: string): Date | null {
  const text = value.trim();
  const ymd = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  const dateParts = ymd
    ? [ymd[1], ymd[2], ymd[3]]
    : dmy ? [dmy[3], dmy[2], dmy[1]] : null;
  if (dateParts) {
    const [yearText, monthText, dayText] = dateParts;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return null;
    }
    return date;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function ensureDefaultCategories(userId: string) {
  const count = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM categories WHERE user_id=?`,
    args: [userId],
  });
  if (Number(count.rows[0]?.count ?? 0) > 0) return;
  const now = new Date().toISOString();
  for (const [name, type] of defaultCategories) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO categories
        (id,user_id,name,category_type,status,created_at,updated_at)
        VALUES (?,?,?,?,'active',?,?)`,
      args: [randomUUID(),userId,name,type,now,now],
    });
  }
}

export function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024, genReqId: () => randomUUID() });
  app.register(cors, {
    origin: (origin, callback) => {
      if (!origin
        || (process.env.NODE_ENV !== "production" && (
          origin.startsWith("http://localhost:")
          || origin.startsWith("http://127.0.0.1:")
          || origin === "https://localhost"
        ))
        || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"), false);
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
  });
  app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  const notificationRetentionTimer = setInterval(() => {
    void db.execute({
      sql: `DELETE FROM notification_events
            WHERE retention_expiry IS NOT NULL AND retention_expiry<=?`,
      args: [new Date().toISOString()],
    }).catch((error) => app.log.error({ err: error }, "Notification retention cleanup failed."));
  }, 60 * 60 * 1000);
  notificationRetentionTimer.unref();
  app.addHook("onClose", async () => clearInterval(notificationRetentionTimer));

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof z.ZodError
      ? 400
      : typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : error instanceof AccountingValidationError
          ? 400
          : 500;
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    const code =
      error instanceof AccountingValidationError
        ? "ACCOUNTING_VALIDATION_ERROR"
        : error instanceof z.ZodError
          ? "VALIDATION_ERROR"
          : status === 401
            ? "UNAUTHORIZED"
            : status === 404
              ? "NOT_FOUND"
              : status === 409
                ? "CONFLICT"
                : "INTERNAL_ERROR";
    if (status >= 500) app.log.error(error);
    reply.status(status).send({
      code,
      message: status >= 500 ? "An unexpected error occurred." : message,
      requestId: request.id,
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/v1/auth/register"
      || request.url === "/api/v1/auth/login"
      || request.url === "/health") return;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      reply.code(401).send({ code: "UNAUTHORIZED", message: "Authentication required.", requestId: request.id });
      return;
    }
    const user = await authenticate(authorization.slice(7));
    if (!user) {
      reply.code(401).send({ code: "UNAUTHORIZED", message: "Invalid or expired session.", requestId: request.id });
      return;
    }
    request.user = user;
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = z.object({
      email: z.email(),
      displayName: z.string().trim().min(1).max(100),
      password: z.string().min(12).max(128),
    }).parse(request.body);
    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(body.password, 12);
    const transaction = await db.transaction("write");
    try {
      await transaction.execute({
        sql: `INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [userId, body.email.toLowerCase(), body.displayName, passwordHash,
          new Date().toISOString(), new Date().toISOString()],
      });
      const now = new Date().toISOString();
      const baseAccounts = [
        ["equity", "Equity - Opening Balances", "equity", "credit"],
        ["income", "Income", "income", "credit"],
        ["expense", "Expense", "expense", "debit"],
      ] as const;
      for (const [code, name, accountClass, normalBalance] of baseAccounts) {
        await transaction.execute({
          sql: `INSERT INTO chart_of_accounts
            (id, user_id, account_code, account_name, account_class, normal_balance, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
          args: [randomUUID(), userId, code, name, accountClass, normalBalance, now],
        });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      if (String(error).toLowerCase().includes("unique")) {
        reply.code(409).send({ code: "EMAIL_EXISTS", message: "An account with this email already exists.", requestId: request.id });
        return;
      }
      throw error;
    } finally {
      transaction.close();
    }
    const session = await createSession(userId, body.email.toLowerCase());
    reply.code(201).send({ user: { id: userId, email: body.email.toLowerCase(), displayName: body.displayName }, ...session });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = z.object({ email: z.email(), password: z.string() }).parse(request.body);
    const result = await db.execute({
      sql: `SELECT id, email, password_hash, status FROM users WHERE email = ?`,
      args: [body.email.toLowerCase()],
    });
    if (result.rows.length !== 1) {
      reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "Invalid email or password.", requestId: request.id });
      return;
    }
    const row = result.rows[0];
    if (row.status !== "active"
      || !await bcrypt.compare(body.password, String(row.password_hash))) {
      reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "Invalid email or password.", requestId: request.id });
      return;
    }
    const session = await createSession(String(row.id), String(row.email));
    reply.send({ user: { id: row.id, email: row.email }, ...session });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    await db.execute({
      sql: `UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?`,
      args: [new Date().toISOString(), request.user!.sessionId, request.user!.userId],
    });
    reply.send({ status: "logged_out" });
  });

  app.get("/api/v1/accounts", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT id, name, account_type, institution_name, masked_account_number,
                   currency, opening_date, status, created_at, updated_at
            FROM accounts WHERE user_id = ? ORDER BY created_at DESC`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/accounts", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      accountType: z.enum(["bank", "cash", "credit_card", "loan", "investment"]),
      institutionName: z.string().trim().max(100).optional(),
      maskedAccountNumber: z.string().trim().max(20).optional(),
      currency: z.string().length(3).default("INR"),
      openingDate: z.iso.datetime().default(() => new Date().toISOString()),
      openingBalanceMinor: z.number().int().optional(),
    }).parse(request.body);
    if (body.openingBalanceMinor === 0) {
      throw new AccountingValidationError("Omit a zero opening balance.");
    }
    const now = new Date().toISOString();
    const accountId = randomUUID();
    const accountLedgerId = randomUUID();
    const transaction = await db.transaction("write");
    try {
    await transaction.execute({
      sql: `INSERT INTO accounts
        (id, user_id, name, account_type, institution_name, masked_account_number,
         currency, opening_date, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [accountId, user.userId, body.name, body.accountType,
        body.institutionName ?? null, body.maskedAccountNumber ?? null,
        body.currency.toUpperCase(), body.openingDate, now, now],
    });
    const liability = body.accountType === "credit_card" || body.accountType === "loan";
    const normalBalance = liability ? "credit" : "debit";
    await transaction.execute({
      sql: `INSERT INTO chart_of_accounts
        (id, user_id, account_code, account_name, account_class, normal_balance,
         linked_financial_account_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      args: [accountLedgerId, user.userId, `account:${accountId}`, body.name,
        liability ? "liability" : "asset", normalBalance,
        accountId, now],
    });
    if (body.openingBalanceMinor !== undefined) {
      const equity = await transaction.execute({
        sql: `SELECT id FROM chart_of_accounts
              WHERE user_id=? AND account_class='equity' AND status='active' LIMIT 1`,
        args: [user.userId],
      });
      if (!equity.rows.length) throw new AccountingValidationError("Opening equity account is missing.");
      const openingId = randomUUID();
      const entryId = randomUUID();
      const amount = BigInt(Math.abs(body.openingBalanceMinor));
      const accountPositive = body.openingBalanceMinor > 0;
      const accountIsDebitNormal = normalBalance === "debit";
      const lines = accountPositive === accountIsDebitNormal
        ? [
            { ledgerAccountId: accountLedgerId, debitMinor: amount, creditMinor: 0n },
            { ledgerAccountId: String(equity.rows[0].id), debitMinor: 0n, creditMinor: amount },
          ]
        : [
            { ledgerAccountId: String(equity.rows[0].id), debitMinor: amount, creditMinor: 0n },
            { ledgerAccountId: accountLedgerId, debitMinor: 0n, creditMinor: amount },
          ];
      validateJournalLines(lines);
      const entryNumber = `OB-${now.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      await transaction.execute({
        sql: `INSERT INTO journal_entries
          (id,user_id,entry_number,description,effective_at,source_type,source_id,status,created_at,posted_at)
          VALUES (?,?,?,'Opening balance',?,'opening_balance',?,'posted',?,?)`,
        args: [entryId,user.userId,entryNumber,body.openingDate,openingId,now,now],
      });
      for (const line of lines) {
        await transaction.execute({
          sql: `INSERT INTO journal_lines
            (id,journal_entry_id,ledger_account_id,debit_minor,credit_minor,currency,description,created_at)
            VALUES (?,?,?,?,?,?,'Opening balance',?)`,
          args: [randomUUID(),entryId,line.ledgerAccountId,Number(line.debitMinor),
            Number(line.creditMinor),body.currency.toUpperCase(),now],
        });
      }
      await transaction.execute({
        sql: `INSERT INTO opening_balances
          (id,user_id,account_id,amount_minor,effective_at,journal_entry_id,created_at)
          VALUES (?,?,?,?,?,?,?)`,
        args: [openingId,user.userId,accountId,body.openingBalanceMinor,body.openingDate,entryId,now],
      });
    }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
    reply.code(201).send({ id: accountId, ...body, status: "active", ledgerAccountId: accountLedgerId });
  });

  app.post("/api/v1/accounts/:id/opening-balance", async (request, reply) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      amountMinor: z.number().int(),
      effectiveAt: z.iso.datetime().default(() => new Date().toISOString()),
      currency: z.string().length(3).default("INR"),
    }).parse(request.body);
    if (body.amountMinor === 0) throw new AccountingValidationError("Opening balance amount must be non-zero.");

    const transaction = await db.transaction("write");
    try {
      const account = await transaction.execute({
        sql: `SELECT a.id, a.currency, l.id AS ledger_id, l.normal_balance
              FROM accounts a
              JOIN chart_of_accounts l
                ON l.linked_financial_account_id = a.id
               AND l.user_id = a.user_id
              WHERE a.id = ? AND a.user_id = ? AND a.status = 'active'`,
        args: [params.id, user.userId],
      });
      if (account.rows.length !== 1) throw new AccountingValidationError("Account is invalid or not owned by the user.");
      if (String(account.rows[0].currency).toUpperCase() !== body.currency.toUpperCase()) {
        throw new AccountingValidationError("Opening balance currency must match the account currency.");
      }
      const equity = await transaction.execute({
        sql: `SELECT id FROM chart_of_accounts
              WHERE user_id = ? AND account_class = 'equity' AND status = 'active' LIMIT 1`,
        args: [user.userId],
      });
      if (equity.rows.length !== 1) throw new AccountingValidationError("Opening equity account is missing.");

      const existing = await transaction.execute({
        sql: `SELECT id FROM opening_balances WHERE user_id = ? AND account_id = ?`,
        args: [user.userId, params.id],
      });
      if (existing.rows.length) throw new AccountingValidationError("Opening balance already exists for this account.");

      const now = new Date().toISOString();
      const entryId = randomUUID();
      const openingBalanceId = randomUUID();
      const entryNumber = `OB-${now.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      const amount = BigInt(Math.abs(body.amountMinor));
      const accountIsDebitNormal = account.rows[0].normal_balance === "debit";
      const balanceIsNormal = body.amountMinor > 0;
      const lines = accountIsDebitNormal === balanceIsNormal
        ? [
            { ledgerAccountId: String(account.rows[0].ledger_id), debitMinor: amount, creditMinor: 0n },
            { ledgerAccountId: String(equity.rows[0].id), debitMinor: 0n, creditMinor: amount },
          ]
        : [
            { ledgerAccountId: String(equity.rows[0].id), debitMinor: amount, creditMinor: 0n },
            { ledgerAccountId: String(account.rows[0].ledger_id), debitMinor: 0n, creditMinor: amount },
          ];
      validateJournalLines(lines);

      await transaction.execute({
        sql: `INSERT INTO journal_entries
          (id, user_id, entry_number, description, effective_at, source_type, source_id, status, created_at, posted_at)
          VALUES (?, ?, ?, 'Opening balance', ?, 'opening_balance', ?, 'posted', ?, ?)`,
        args: [entryId, user.userId, entryNumber, body.effectiveAt, openingBalanceId, now, now],
      });
      for (const line of lines) {
        await transaction.execute({
          sql: `INSERT INTO journal_lines
            (id, journal_entry_id, ledger_account_id, debit_minor, credit_minor, currency, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'Opening balance', ?)`,
          args: [randomUUID(), entryId, line.ledgerAccountId, Number(line.debitMinor),
            Number(line.creditMinor), body.currency.toUpperCase(), now],
        });
      }
      await transaction.execute({
        sql: `INSERT INTO opening_balances
          (id, user_id, account_id, amount_minor, effective_at, journal_entry_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [openingBalanceId, user.userId, params.id, body.amountMinor,
          body.effectiveAt, entryId, now],
      });
      await transaction.commit();
      reply.code(201).send({ id: openingBalanceId, journalEntryId: entryId, amountMinor: body.amountMinor });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.post("/api/v1/transactions", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      transactionType: z.enum(["income", "expense"]),
      amountMinor: z.number().int().positive(),
      currency: z.string().length(3).default("INR"),
      accountId: z.uuid(),
      categoryId: z.string().optional(),
      description: z.string().trim().max(500).optional(),
      transactionAt: z.iso.datetime().default(() => new Date().toISOString()),
      idempotencyKey: z.string().trim().min(1).max(128).optional(),
    }).parse(request.body);

    const transaction = await db.transaction("write");
    try {
      if (body.idempotencyKey) {
        const existing = await transaction.execute({
          sql: `SELECT id, journal_entry_id FROM transactions
                WHERE user_id = ? AND idempotency_key = ?`,
          args: [user.userId, body.idempotencyKey],
        });
        if (existing.rows.length) {
          await transaction.commit();
          reply.send({ id: existing.rows[0].id, journalEntryId: existing.rows[0].journal_entry_id, duplicate: true });
          return;
        }
      }

      const account = await transaction.execute({
        sql: `SELECT id, currency FROM accounts WHERE id = ? AND user_id = ? AND status = 'active'`,
        args: [body.accountId, user.userId],
      });
      if (account.rows.length !== 1) throw new AccountingValidationError("Account is invalid or not owned by the user.");
      if (String(account.rows[0].currency).toUpperCase() !== body.currency.toUpperCase()) {
        throw new AccountingValidationError("Transaction currency must match the account currency.");
      }
      if (body.categoryId) {
        const category = await transaction.execute({
          sql: `SELECT id,category_type FROM categories
                WHERE id=? AND (user_id=? OR user_id IS NULL) AND status='active'`,
          args: [body.categoryId,user.userId],
        });
        if (!category.rows.length || category.rows[0].category_type !== body.transactionType) {
          throw new AccountingValidationError("Category is invalid for this transaction.");
        }
      }

      const now = new Date().toISOString();
      const entryId = randomUUID();
      const transactionId = randomUUID();
      const entryNumber = `JE-${now.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      const incomeOrExpenseAccount = await transaction.execute({
        sql: `SELECT id FROM chart_of_accounts
              WHERE user_id = ? AND account_class = ? AND status = 'active' LIMIT 1`,
        args: [user.userId, body.transactionType === "income" ? "income" : "expense"],
      });
      if (incomeOrExpenseAccount.rows.length !== 1) {
        throw new AccountingValidationError("A chart-of-accounts entry for this transaction type is required.");
      }

      const financialAccountLedger = await transaction.execute({
        sql: `SELECT id FROM chart_of_accounts
              WHERE user_id = ? AND linked_financial_account_id = ? AND status = 'active' LIMIT 1`,
        args: [user.userId, body.accountId],
      });
      if (financialAccountLedger.rows.length !== 1) {
        throw new AccountingValidationError("The account does not have a linked ledger account.");
      }

      const lines = body.transactionType === "income"
        ? [
            { ledgerAccountId: String(financialAccountLedger.rows[0].id), debitMinor: BigInt(body.amountMinor), creditMinor: 0n },
            { ledgerAccountId: String(incomeOrExpenseAccount.rows[0].id), debitMinor: 0n, creditMinor: BigInt(body.amountMinor) },
          ]
        : [
            { ledgerAccountId: String(incomeOrExpenseAccount.rows[0].id), debitMinor: BigInt(body.amountMinor), creditMinor: 0n },
            { ledgerAccountId: String(financialAccountLedger.rows[0].id), debitMinor: 0n, creditMinor: BigInt(body.amountMinor) },
          ];
      validateJournalLines(lines);

      await transaction.execute({
        sql: `INSERT INTO journal_entries
          (id, user_id, entry_number, description, effective_at, source_type, source_id, status, created_at, posted_at)
          VALUES (?, ?, ?, ?, ?, 'transaction', ?, 'posted', ?, ?)`,
        args: [entryId, user.userId, entryNumber, body.description ?? null,
          body.transactionAt, transactionId, now, now],
      });
      for (const line of lines) {
        await transaction.execute({
          sql: `INSERT INTO journal_lines
            (id, journal_entry_id, ledger_account_id, debit_minor, credit_minor, currency, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [randomUUID(), entryId, line.ledgerAccountId,
            Number(line.debitMinor), Number(line.creditMinor),
            body.currency.toUpperCase(), body.description ?? null, now],
        });
      }
      await transaction.execute({
        sql: `INSERT INTO transactions
          (id, user_id, journal_entry_id, transaction_type, amount_minor, currency,
           account_id, category_id, description, transaction_at, status, source_type,
           idempotency_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', 'manual', ?, ?, ?)`,
        args: [transactionId, user.userId, entryId, body.transactionType, body.amountMinor,
          body.currency.toUpperCase(), body.accountId, body.categoryId ?? null,
          body.description ?? null, body.transactionAt, body.idempotencyKey ?? null, now, now],
      });
      await transaction.commit();
      reply.code(201).send({ id: transactionId, journalEntryId: entryId, duplicate: false });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/transactions", async (request) => {
    const user = request.user!;
    const query = z.object({
      accountId: z.uuid().optional(),
      transactionType: z.enum(["income","expense","transfer"]).optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      status: z.enum(["posted","pending","reversed","rejected"]).optional(),
      categoryId: z.uuid().optional(),
      sourceType: z.string().trim().min(1).max(100).optional(),
      search: z.string().trim().max(100).optional(),
      sort: z.enum(["newest","oldest","highest","lowest"]).default("newest"),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(request.query);
    if (query.from && query.to && query.from > query.to) {
      throw new AccountingValidationError("Start date must not be after end date.");
    }
    const searchAmount = query.search ? Number(query.search.replace(/[₹,\s]/g, "")) : Number.NaN;
    const searchAmountMinor = Number.isFinite(searchAmount) && Number.isSafeInteger(Math.round(searchAmount * 100))
      ? Math.round(searchAmount * 100)
      : null;
    const orderBy = {
      newest: "t.transaction_at DESC, t.created_at DESC",
      oldest: "t.transaction_at ASC, t.created_at ASC",
      highest: "t.amount_minor DESC, t.transaction_at DESC",
      lowest: "t.amount_minor ASC, t.transaction_at DESC",
    }[query.sort];
    const result = await db.execute({
      sql: `SELECT t.id, t.transaction_type, t.amount_minor, t.currency, t.account_id,
                   a.name AS account_name, t.category_id, c.name AS category_name,
                   p.display_name AS payee_name, t.description, t.transaction_at, t.status,
                   t.source_type, t.source_reference, t.created_at
            FROM transactions t
            JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id
            LEFT JOIN categories c ON c.id=t.category_id
              AND (c.user_id=t.user_id OR c.user_id IS NULL)
            LEFT JOIN payees p ON p.id=t.payee_id AND p.user_id=t.user_id
            WHERE t.user_id = ?
              AND (? IS NULL OR t.account_id = ?)
              AND (? IS NULL OR t.transaction_type = ?)
              AND (? IS NULL OR substr(t.transaction_at,1,10) >= ?)
              AND (? IS NULL OR substr(t.transaction_at,1,10) <= ?)
              AND (? IS NULL OR t.status = ?)
              AND (? IS NULL OR t.category_id = ?)
              AND (? IS NULL OR t.source_type = ?)
              AND (? IS NULL OR t.description LIKE '%' || ? || '%'
                OR a.name LIKE '%' || ? || '%'
                OR c.name LIKE '%' || ? || '%'
                OR p.display_name LIKE '%' || ? || '%'
                OR t.source_reference LIKE '%' || ? || '%'
                OR (? IS NOT NULL AND t.amount_minor = ?))
            ORDER BY ${orderBy} LIMIT ?`,
      args: [user.userId,query.accountId ?? null,query.accountId ?? null,
        query.transactionType ?? null,query.transactionType ?? null,
        query.from ?? null,query.from ?? null,query.to ?? null,query.to ?? null,
        query.status ?? null,query.status ?? null,
        query.categoryId ?? null,query.categoryId ?? null,
        query.sourceType ?? null,query.sourceType ?? null,
        query.search ?? null,query.search ?? null,query.search ?? null,query.search ?? null,
        query.search ?? null,query.search ?? null,searchAmountMinor,searchAmountMinor,query.limit],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/transfers", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      fromAccountId: z.uuid(),
      toAccountId: z.uuid(),
      amountMinor: z.number().int().positive(),
      currency: z.string().length(3).default("INR"),
      description: z.string().trim().max(500).optional(),
      transactionAt: z.iso.datetime().default(() => new Date().toISOString()),
      idempotencyKey: z.string().trim().min(1).max(128),
    }).parse(request.body);
    if (body.fromAccountId === body.toAccountId) {
      throw new AccountingValidationError("Source and destination accounts must be different.");
    }

    const transaction = await db.transaction("write");
    try {
      const existing = await transaction.execute({
        sql: `SELECT id, journal_entry_id FROM transactions WHERE user_id = ? AND idempotency_key = ?`,
        args: [user.userId, body.idempotencyKey],
      });
      if (existing.rows.length) {
        await transaction.commit();
        reply.send({ id: existing.rows[0].id, journalEntryId: existing.rows[0].journal_entry_id, duplicate: true });
        return;
      }
      const accounts = await transaction.execute({
        sql: `SELECT a.id, a.currency, l.id AS ledger_id
              FROM accounts a JOIN chart_of_accounts l
                ON l.linked_financial_account_id = a.id
               AND l.user_id = a.user_id
              WHERE a.user_id = ? AND a.status = 'active'
                AND a.id IN (?, ?)`,
        args: [user.userId, body.fromAccountId, body.toAccountId],
      });
      if (accounts.rows.length !== 2) throw new AccountingValidationError("Both accounts must belong to the user.");
      const from = accounts.rows.find((row) => String(row.id) === body.fromAccountId);
      const to = accounts.rows.find((row) => String(row.id) === body.toAccountId);
      if (!from || !to) throw new AccountingValidationError("Transfer account lookup failed.");
      if (String(from.currency).toUpperCase() !== body.currency.toUpperCase()
        || String(to.currency).toUpperCase() !== body.currency.toUpperCase()) {
        throw new AccountingValidationError("Transfer currency must match both accounts.");
      }

      const now = new Date().toISOString();
      const entryId = randomUUID();
      const transactionId = randomUUID();
      const entryNumber = `TF-${now.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      const amount = BigInt(body.amountMinor);
      validateJournalLines([
        { ledgerAccountId: String(to.ledger_id), debitMinor: amount, creditMinor: 0n },
        { ledgerAccountId: String(from.ledger_id), debitMinor: 0n, creditMinor: amount },
      ]);
      await transaction.execute({
        sql: `INSERT INTO journal_entries
          (id,user_id,entry_number,description,effective_at,source_type,source_id,status,created_at,posted_at)
          VALUES (?,?,?,?,?, 'transfer', ?, 'posted', ?, ?)`,
        args: [entryId, user.userId, entryNumber, body.description ?? null,
          body.transactionAt, transactionId, now, now],
      });
      for (const line of [
        { ledgerAccountId: String(to.ledger_id), debitMinor: amount, creditMinor: 0n },
        { ledgerAccountId: String(from.ledger_id), debitMinor: 0n, creditMinor: amount },
      ]) {
        await transaction.execute({
          sql: `INSERT INTO journal_lines
            (id,journal_entry_id,ledger_account_id,debit_minor,credit_minor,currency,description,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
          args: [randomUUID(), entryId, line.ledgerAccountId, Number(line.debitMinor),
            Number(line.creditMinor), body.currency.toUpperCase(), body.description ?? null, now],
        });
      }
      await transaction.execute({
        sql: `INSERT INTO transactions
          (id,user_id,journal_entry_id,transaction_type,amount_minor,currency,account_id,
           description,transaction_at,status,source_type,idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'posted','transfer',?,?,?)`,
        args: [transactionId, user.userId, entryId, "transfer", body.amountMinor,
          body.currency.toUpperCase(), body.fromAccountId, body.description ?? null,
          body.transactionAt, body.idempotencyKey, now, now],
      });
      await transaction.commit();
      reply.code(201).send({ id: transactionId, journalEntryId: entryId, duplicate: false });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/accounts/:id/balance", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `SELECT c.normal_balance,
                   COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_minor ELSE 0 END),0) AS debit_minor,
                   COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit_minor ELSE 0 END),0) AS credit_minor,
                   a.currency
            FROM accounts a
            JOIN chart_of_accounts c ON c.linked_financial_account_id = a.id AND c.user_id = a.user_id
            LEFT JOIN journal_lines jl ON jl.ledger_account_id = c.id
            LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
            WHERE a.id = ? AND a.user_id = ?
            GROUP BY c.normal_balance, c.id, a.currency`,
      args: [params.id, user.userId],
    });
    if (!result.rows.length) throw new AccountingValidationError("Account not found.");
    const row = result.rows[0];
    const debit = Number(row.debit_minor);
    const credit = Number(row.credit_minor);
    const balanceMinor = row.normal_balance === "debit" ? debit - credit : credit - debit;
    return { accountId: params.id, currency: row.currency, balanceMinor };
  });

  app.get("/api/v1/accounts/:id/transactions", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `SELECT id,transaction_type,amount_minor,currency,category_id,description,
                   transaction_at,status,source_type
            FROM transactions WHERE user_id=? AND account_id=?
            ORDER BY transaction_at DESC LIMIT 500`,
      args: [user.userId,params.id],
    });
    return { items: result.rows };
  });

  app.get("/api/v1/reports/summary", async (request) => {
    const user = request.user!;
    const query = z.object({
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
    }).refine((value) => !value.from || !value.to || value.from <= value.to, {
      message: "The start date must not be after the end date.",
    }).parse(request.query);
    const profile = await db.execute({
      sql: `SELECT default_currency FROM users WHERE id=?`,
      args: [user.userId],
    });
    const currency = String(profile.rows[0]?.default_currency ?? "INR").toUpperCase();
    const result = await db.execute({
      sql: `SELECT c.account_class,
                   SUM(jl.debit_minor) AS debit_minor,
                   SUM(jl.credit_minor) AS credit_minor
            FROM journal_entries je
            JOIN journal_lines jl ON jl.journal_entry_id=je.id
            JOIN chart_of_accounts c ON c.id=jl.ledger_account_id
            WHERE je.user_id=? AND je.status='posted'
              AND jl.currency=? AND c.account_class IN ('income','expense')
              AND (? IS NULL OR substr(je.effective_at,1,10)>=?)
              AND (? IS NULL OR substr(je.effective_at,1,10)<=?)
            GROUP BY c.account_class`,
      args: [user.userId,currency,query.from ?? null,query.from ?? null,query.to ?? null,query.to ?? null],
    });
    const totals = { incomeMinor: 0, expenseMinor: 0 };
    for (const row of result.rows) {
      const debit = Number(row.debit_minor);
      const credit = Number(row.credit_minor);
      if (row.account_class === "income") totals.incomeMinor = credit - debit;
      if (row.account_class === "expense") totals.expenseMinor = debit - credit;
    }
    const accounts = await db.execute({
      sql: `SELECT id FROM accounts WHERE user_id = ? AND status = 'active' AND currency=?`,
      args: [user.userId,currency],
    });
    let assetsMinor = 0;
    let liabilitiesMinor = 0;
    for (const account of accounts.rows) {
      const balanceResult = await db.execute({
        sql: `SELECT c.normal_balance,
                     COALESCE(SUM(jl.debit_minor),0) AS debit_minor,
                     COALESCE(SUM(jl.credit_minor),0) AS credit_minor
              FROM chart_of_accounts c
              LEFT JOIN journal_lines jl ON jl.ledger_account_id = c.id
              LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
              WHERE c.user_id = ? AND c.linked_financial_account_id = ?
              GROUP BY c.normal_balance`,
        args: [user.userId, String(account.id)],
      });
      if (balanceResult.rows.length) {
        const row = balanceResult.rows[0];
        const debit = Number(row.debit_minor);
        const credit = Number(row.credit_minor);
        if (row.normal_balance === "debit") assetsMinor += debit - credit;
        else liabilitiesMinor += credit - debit;
      }
    }
    const currencies = await db.execute({
      sql: `SELECT currency FROM accounts WHERE user_id=? AND status='active' GROUP BY currency ORDER BY currency`,
      args: [user.userId],
    });
    return {
      currency,
      ...totals,
      assetsMinor,
      liabilitiesMinor,
      netWorthMinor: assetsMinor - liabilitiesMinor,
      otherCurrencies: currencies.rows
        .map((row) => String(row.currency))
        .filter((accountCurrency) => accountCurrency !== currency),
    };
  });

  app.get("/api/v1/categories", async (request) => {
    const user = request.user!;
    await ensureDefaultCategories(user.userId);
    const result = await db.execute({
      sql: `SELECT id,name,category_type,parent_id,status FROM categories
            WHERE (user_id = ? OR user_id IS NULL) AND status = 'active'
            ORDER BY category_type,name`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/categories", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      categoryType: z.enum(["income", "expense"]),
      parentId: z.string().nullable().optional(),
    }).parse(request.body);
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO categories
        (id,user_id,name,category_type,parent_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,'active',?,?)`,
      args: [id, user.userId, body.name, body.categoryType, body.parentId ?? null, now, now],
    });
    reply.code(201).send({ id, ...body, status: "active" });
  });

  app.get("/api/v1/budgets", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT b.*,
                   (SELECT group_concat(c.name, ', ')
                    FROM budget_categories bc
                    JOIN categories c ON c.id=bc.category_id
                    WHERE bc.budget_id=b.id) AS category_names,
                   COALESCE(SUM(t.amount_minor),0) AS spent_minor
            FROM budgets b
            LEFT JOIN transactions t
              ON t.user_id=b.user_id
             AND t.transaction_type='expense'
             AND t.status='posted'
             AND UPPER(t.currency)=UPPER(b.currency)
             AND substr(t.transaction_at,1,10) BETWEEN b.start_date AND b.end_date
             AND (NOT EXISTS (
                    SELECT 1 FROM budget_categories bc WHERE bc.budget_id=b.id
                  ) OR EXISTS (
                    SELECT 1 FROM budget_categories bc
                    WHERE bc.budget_id=b.id AND bc.category_id=t.category_id
                  ))
            WHERE b.user_id=? AND b.status='active'
            GROUP BY b.id
            ORDER BY b.start_date DESC`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/budgets", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      periodType: z.enum(["daily","weekly","monthly","yearly","custom"]),
      startDate: z.iso.date(),
      endDate: z.iso.date(),
      totalLimitMinor: z.number().int().nonnegative(),
      currency: z.string().length(3).default("INR"),
      rolloverPolicy: z.enum(["none","carry_remaining"]).default("none"),
      alertThreshold: z.number().int().min(1).max(100).default(90),
      categoryAllocations: z.array(z.object({
        categoryId: z.uuid(),
        limitMinor: z.number().int().positive(),
      })).max(50).default([]),
    }).parse(request.body);
    if (body.totalLimitMinor === 0) throw new AccountingValidationError("Budget limit must be greater than zero.");
    if (body.endDate < body.startDate) throw new AccountingValidationError("Budget end date must not precede start date.");
    const categoryIds = body.categoryAllocations.map((allocation) => allocation.categoryId);
    if (new Set(categoryIds).size !== categoryIds.length) {
      throw new AccountingValidationError("A category can only be added to a budget once.");
    }
    const allocatedMinor = body.categoryAllocations.reduce((total, allocation) => total + allocation.limitMinor, 0);
    if (allocatedMinor > body.totalLimitMinor) {
      throw new AccountingValidationError("Category allocations cannot exceed the total budget limit.");
    }
    if (categoryIds.length) {
      const placeholders = categoryIds.map(() => "?").join(",");
      const categories = await db.execute({
        sql: `SELECT id FROM categories
              WHERE (user_id=? OR user_id IS NULL) AND category_type='expense'
                AND status='active' AND id IN (${placeholders})`,
        args: [user.userId, ...categoryIds],
      });
      if (categories.rows.length !== categoryIds.length) {
        throw new AccountingValidationError("Budget categories must be active expense categories owned by the user.");
      }
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const transaction = await db.transaction("write");
    try {
      await transaction.execute({
        sql: `INSERT INTO budgets
          (id,user_id,name,period_type,start_date,end_date,total_limit_minor,currency,rollover_policy,alert_threshold,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
        args: [id,user.userId,body.name,body.periodType,body.startDate,body.endDate,
          body.totalLimitMinor,body.currency.toUpperCase(),body.rolloverPolicy,body.alertThreshold,now,now],
      });
      for (const allocation of body.categoryAllocations) {
        await transaction.execute({
          sql: `INSERT INTO budget_categories (id,budget_id,category_id,limit_minor,created_at) VALUES (?,?,?,?,?)`,
          args: [randomUUID(),id,allocation.categoryId,allocation.limitMinor,now],
        });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
    reply.code(201).send({ id, ...body, status: "active" });
  });

  app.get("/api/v1/budgets/:id", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `SELECT * FROM budgets WHERE id=? AND user_id=? AND status='active'`,
      args: [params.id,user.userId],
    });
    if (!result.rows.length) throw new AccountingValidationError("Budget not found.");
    const allocations = await db.execute({
      sql: `SELECT category_id,limit_minor FROM budget_categories WHERE budget_id=? ORDER BY created_at`,
      args: [params.id],
    });
    return { budget: result.rows[0], categoryAllocations: allocations.rows };
  });

  app.patch("/api/v1/budgets/:id", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      periodType: z.enum(["daily","weekly","monthly","yearly","custom"]).optional(),
      startDate: z.iso.date().optional(),
      endDate: z.iso.date().optional(),
      totalLimitMinor: z.number().int().positive().optional(),
      rolloverPolicy: z.enum(["none","carry_remaining"]).optional(),
      alertThreshold: z.number().int().min(1).max(100).optional(),
      categoryAllocations: z.array(z.object({
        categoryId: z.uuid(),
        limitMinor: z.number().int().positive(),
      })).max(50).optional(),
    }).refine((value) => Object.keys(value).length > 0, {
      message: "At least one budget field is required.",
    }).parse(request.body);
    const transaction = await db.transaction("write");
    try {
      const currentResult = await transaction.execute({
        sql: `SELECT * FROM budgets WHERE id=? AND user_id=? AND status='active'`,
        args: [params.id,user.userId],
      });
      if (!currentResult.rows.length) throw new AccountingValidationError("Budget not found.");
      const current = currentResult.rows[0];
      const startDate = body.startDate ?? String(current.start_date);
      const endDate = body.endDate ?? String(current.end_date);
      const limitMinor = body.totalLimitMinor ?? Number(current.total_limit_minor);
      if (endDate < startDate) throw new AccountingValidationError("Budget end date must not precede start date.");

      const allocationsResult = await transaction.execute({
        sql: `SELECT category_id,limit_minor FROM budget_categories WHERE budget_id=?`,
        args: [params.id],
      });
      const allocations = body.categoryAllocations ?? allocationsResult.rows.map((row) => ({
        categoryId: String(row.category_id),
        limitMinor: Number(row.limit_minor),
      }));
      if (new Set(allocations.map((allocation) => allocation.categoryId)).size !== allocations.length) {
        throw new AccountingValidationError("A category can only be added to a budget once.");
      }
      if (allocations.reduce((total, allocation) => total + allocation.limitMinor, 0) > limitMinor) {
        throw new AccountingValidationError("Category allocations cannot exceed the total budget limit.");
      }
      if (body.categoryAllocations !== undefined && allocations.length) {
        const placeholders = allocations.map(() => "?").join(",");
        const categories = await transaction.execute({
          sql: `SELECT id FROM categories
                WHERE (user_id=? OR user_id IS NULL) AND category_type='expense'
                  AND status='active' AND id IN (${placeholders})`,
          args: [user.userId,...allocations.map((allocation) => allocation.categoryId)],
        });
        if (categories.rows.length !== allocations.length) {
          throw new AccountingValidationError("Budget categories must be active expense categories owned by the user.");
        }
      }

      const now = new Date().toISOString();
      await transaction.execute({
        sql: `UPDATE budgets SET name=?,period_type=?,start_date=?,end_date=?,total_limit_minor=?,
                     rollover_policy=?,alert_threshold=?,updated_at=?
              WHERE id=? AND user_id=? AND status='active'`,
        args: [body.name ?? current.name,body.periodType ?? current.period_type,startDate,endDate,limitMinor,
          body.rolloverPolicy ?? current.rollover_policy,body.alertThreshold ?? current.alert_threshold,
          now,params.id,user.userId],
      });
      if (body.categoryAllocations !== undefined) {
        await transaction.execute({ sql: `DELETE FROM budget_categories WHERE budget_id=?`, args: [params.id] });
        for (const allocation of body.categoryAllocations) {
          await transaction.execute({
            sql: `INSERT INTO budget_categories (id,budget_id,category_id,limit_minor,created_at) VALUES (?,?,?,?,?)`,
            args: [randomUUID(),params.id,allocation.categoryId,allocation.limitMinor,now],
          });
        }
      }
      await transaction.execute({
        sql: `INSERT INTO audit_log
          (id,user_id,actor_id,entity_type,entity_id,action,before_data,after_data,created_at)
          VALUES (?,?,?,'budget',?,'updated',?,?,?)`,
        args: [randomUUID(),user.userId,user.userId,params.id,JSON.stringify(current),JSON.stringify({
          name: body.name ?? current.name,
          periodType: body.periodType ?? current.period_type,
          startDate,
          endDate,
          totalLimitMinor: limitMinor,
          rolloverPolicy: body.rolloverPolicy ?? current.rollover_policy,
          alertThreshold: body.alertThreshold ?? current.alert_threshold,
          categoryAllocations: allocations,
        }),now],
      });
      await transaction.commit();
      return { status: "updated", id: params.id };
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.post("/api/v1/budgets/:id/archive", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `UPDATE budgets SET status='archived',updated_at=? WHERE id=? AND user_id=? AND status='active'`,
      args: [new Date().toISOString(),params.id,user.userId],
    });
    if (Number(result.rowsAffected) !== 1) throw new AccountingValidationError("Budget not found.");
    return { status: "archived", id: params.id };
  });

  app.get("/api/v1/loans", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT * FROM loans WHERE user_id = ? AND status = 'active' ORDER BY start_date DESC`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.get("/api/v1/loans/:id/outstanding", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const loan = await db.execute({
      sql: `SELECT account_id FROM loans WHERE id=? AND user_id=?`,
      args: [params.id,user.userId],
    });
    if (!loan.rows.length) throw new AccountingValidationError("Loan not found.");
    const balance = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${String(loan.rows[0].account_id)}/balance`,
      headers: { authorization: request.headers.authorization },
    });
    return { loanId: params.id, ...balance.json() as object };
  });

  app.post("/api/v1/loans", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      accountId: z.uuid(),
      lenderName: z.string().trim().min(1).max(100),
      loanType: z.enum(["personal","home","vehicle","education","other"]),
      originalPrincipalMinor: z.number().int().positive(),
      interestRate: z.string().default("0"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      tenureMonths: z.number().int().positive().optional(),
    }).parse(request.body);
    const account = await db.execute({
      sql: `SELECT id,account_type FROM accounts WHERE id = ? AND user_id = ? AND status = 'active'`,
      args: [body.accountId,user.userId],
    });
    if (!account.rows.length) throw new AccountingValidationError("Loan account is invalid.");
    if (account.rows[0].account_type !== "loan") {
      throw new AccountingValidationError("Select an account with the loan type.");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO loans
        (id,user_id,account_id,lender_name,loan_type,original_principal_minor,interest_rate,start_date,end_date,tenure_months,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'active',?,?)`,
      args: [id,user.userId,body.accountId,body.lenderName,body.loanType,
        body.originalPrincipalMinor,body.interestRate,body.startDate,body.endDate ?? null,
        body.tenureMonths ?? null,now,now],
    });
    reply.code(201).send({ id, ...body, status: "active" });
  });

  app.get("/api/v1/credit-cards", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT c.*,a.currency,
                   COALESCE(SUM(CASE WHEN je.status='posted'
                     THEN jl.credit_minor-jl.debit_minor ELSE 0 END),0) AS outstanding_minor,
                   c.credit_limit_minor-COALESCE(SUM(CASE WHEN je.status='posted'
                     THEN jl.credit_minor-jl.debit_minor ELSE 0 END),0) AS available_limit_minor
            FROM credit_cards c
            JOIN accounts a ON a.id=c.account_id AND a.user_id=c.user_id
            JOIN chart_of_accounts coa ON coa.linked_financial_account_id=c.account_id AND coa.user_id=c.user_id
            LEFT JOIN journal_lines jl ON jl.ledger_account_id=coa.id
            LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id
            WHERE c.user_id=? AND c.status='active'
            GROUP BY c.id
            ORDER BY c.created_at DESC`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/credit-cards", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      accountId: z.uuid(),
      issuer: z.string().trim().max(100).optional(),
      cardName: z.string().trim().min(1).max(100),
      maskedCardNumber: z.string().trim().max(20).optional(),
      creditLimitMinor: z.number().int().nonnegative(),
      statementDay: z.number().int().min(1).max(31).optional(),
      dueDay: z.number().int().min(1).max(31).optional(),
      linkedPaymentAccountId: z.uuid().optional(),
    }).parse(request.body);
    const owned = await db.execute({
      sql: `SELECT id,account_type FROM accounts WHERE id = ? AND user_id = ? AND status = 'active'`,
      args: [body.accountId,user.userId],
    });
    if (!owned.rows.length) throw new AccountingValidationError("Card account is invalid.");
    if (owned.rows[0].account_type !== "credit_card") {
      throw new AccountingValidationError("Select a credit card account.");
    }
    if (body.linkedPaymentAccountId) {
      const paymentAccount = await db.execute({
        sql: `SELECT id,currency FROM accounts WHERE id=? AND user_id=? AND status='active'`,
        args: [body.linkedPaymentAccountId,user.userId],
      });
      if (!paymentAccount.rows.length) throw new AccountingValidationError("Linked payment account is invalid.");
      const cardAccount = await db.execute({
        sql: `SELECT currency FROM accounts WHERE id=? AND user_id=?`,
        args: [body.accountId,user.userId],
      });
      if (String(paymentAccount.rows[0].currency).toUpperCase() !== String(cardAccount.rows[0]?.currency).toUpperCase()) {
        throw new AccountingValidationError("Linked payment account must use the card's currency.");
      }
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO credit_cards
        (id,user_id,account_id,issuer,card_name,masked_card_number,credit_limit_minor,statement_day,due_day,linked_payment_account_id,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'active',?)`,
      args: [id,user.userId,body.accountId,body.issuer ?? null,body.cardName,
        body.maskedCardNumber ?? null,body.creditLimitMinor,body.statementDay ?? null,
        body.dueDay ?? null,body.linkedPaymentAccountId ?? null,now],
    });
    reply.code(201).send({ id, ...body, status: "active" });
  });

  app.get("/api/v1/credit-cards/:id/outstanding", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const card = await db.execute({
      sql: `SELECT account_id,credit_limit_minor FROM credit_cards WHERE id=? AND user_id=?`,
      args: [params.id,user.userId],
    });
    if (!card.rows.length) throw new AccountingValidationError("Credit card not found.");
    const balance = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${String(card.rows[0].account_id)}/balance`,
      headers: { authorization: request.headers.authorization },
    });
    return { cardId: params.id, creditLimitMinor: Number(card.rows[0].credit_limit_minor), ...balance.json() as object };
  });

  app.get("/api/v1/credit-cards/:id/statement", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const query = z.object({
      from: z.iso.date(),
      to: z.iso.date(),
    }).refine((value) => value.from <= value.to, "Statement start date must not be after end date.").parse(request.query);
    const cardResult = await db.execute({
      sql: `SELECT c.card_name,c.account_id,a.currency,coa.id AS ledger_account_id
            FROM credit_cards c
            JOIN accounts a ON a.id=c.account_id AND a.user_id=c.user_id
            JOIN chart_of_accounts coa ON coa.linked_financial_account_id=c.account_id AND coa.user_id=c.user_id
            WHERE c.id=? AND c.user_id=? AND c.status='active'`,
      args: [params.id,user.userId],
    });
    if (!cardResult.rows.length) throw new AccountingValidationError("Credit card not found.");
    const card = cardResult.rows[0];
    const nextDay = new Date(`${query.to}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const endExclusive = nextDay.toISOString();
    const startInclusive = `${query.from}T00:00:00.000Z`;
    const opening = await db.execute({
      sql: `SELECT COALESCE(SUM(jl.credit_minor-jl.debit_minor),0) AS balance_minor
            FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id
            WHERE jl.ledger_account_id=? AND je.user_id=? AND je.status='posted'
              AND je.effective_at<?`,
      args: [String(card.ledger_account_id),user.userId,startInclusive],
    });
    const entries = await db.execute({
      sql: `SELECT je.id AS journal_entry_id,je.effective_at,je.source_type,
                   COALESCE(t.description,je.description,je.source_type) AS description,
                   t.id AS transaction_id,
                   COALESCE(SUM(jl.credit_minor-jl.debit_minor),0) AS amount_minor
            FROM journal_entries je
            JOIN journal_lines jl ON jl.journal_entry_id=je.id
            LEFT JOIN transactions t ON t.journal_entry_id=je.id AND t.user_id=je.user_id
            WHERE je.user_id=? AND je.status='posted'
              AND jl.ledger_account_id=? AND je.effective_at>=? AND je.effective_at<?
            GROUP BY je.id,t.id
            ORDER BY je.effective_at,je.created_at,je.id`,
      args: [user.userId,String(card.ledger_account_id),startInclusive,endExclusive],
    });
    const openingBalanceMinor = Number(opening.rows[0]?.balance_minor ?? 0);
    const items = entries.rows.map((row) => ({ ...row, amount_minor: Number(row.amount_minor) }));
    const closingBalanceMinor = openingBalanceMinor + items.reduce((total, item) => total + item.amount_minor, 0);
    return {
      cardId: params.id,
      cardName: card.card_name,
      currency: card.currency,
      from: query.from,
      to: query.to,
      openingBalanceMinor,
      closingBalanceMinor,
      items,
    };
  });

  app.post("/api/v1/credit-cards/:id/payment", async (request, reply) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      paymentAccountId: z.uuid(),
      amountMinor: z.number().int().positive(),
      paymentAt: z.iso.datetime().default(() => new Date().toISOString()),
      idempotencyKey: z.string().trim().min(1).max(128),
    }).parse(request.body);
    const card = await db.execute({
      sql: `SELECT c.account_id,ca.currency,cl.id AS card_ledger
            FROM credit_cards c JOIN accounts ca ON ca.id=c.account_id
            JOIN chart_of_accounts cl ON cl.linked_financial_account_id=c.account_id
              AND cl.user_id=c.user_id
            WHERE c.id=? AND c.user_id=? AND c.status='active'`,
      args: [params.id,user.userId],
    });
    const payment = await db.execute({
      sql: `SELECT a.currency,l.id AS payment_ledger FROM accounts a
            JOIN chart_of_accounts l ON l.linked_financial_account_id=a.id AND l.user_id=a.user_id
            WHERE a.id=? AND a.user_id=? AND a.status='active'`,
      args: [body.paymentAccountId,user.userId],
    });
    if (!card.rows.length || !payment.rows.length) throw new AccountingValidationError("Card or payment account not found.");
    if (String(card.rows[0].currency) !== String(payment.rows[0].currency)) {
      throw new AccountingValidationError("Card payment accounts must have the same currency.");
    }

    const transaction = await db.transaction("write");
    try {
      const duplicate = await transaction.execute({
        sql: `SELECT id,journal_entry_id FROM transactions WHERE user_id=? AND idempotency_key=?`,
        args: [user.userId,body.idempotencyKey],
      });
      if (duplicate.rows.length) {
        await transaction.commit();
        return reply.send({ id:duplicate.rows[0].id,journalEntryId:duplicate.rows[0].journal_entry_id,duplicate:true });
      }
      const entryId=randomUUID();
      const transactionId=randomUUID();
      const now=new Date().toISOString();
      const entryNumber=`CC-${now.replace(/\D/g,"").slice(0,14)}-${randomUUID().slice(0,8)}`;
      const lines=[
        {ledgerAccountId:String(card.rows[0].card_ledger),debitMinor:BigInt(body.amountMinor),creditMinor:0n},
        {ledgerAccountId:String(payment.rows[0].payment_ledger),debitMinor:0n,creditMinor:BigInt(body.amountMinor)},
      ];
      validateJournalLines(lines);
      await transaction.execute({
        sql:`INSERT INTO journal_entries
          (id,user_id,entry_number,description,effective_at,source_type,source_id,status,created_at,posted_at)
          VALUES (?,?,?,'Credit card bill payment',?,'credit_card_payment',?,'posted',?,?)`,
        args:[entryId,user.userId,entryNumber,body.paymentAt,transactionId,now,now],
      });
      for (const line of lines) {
        await transaction.execute({
          sql:`INSERT INTO journal_lines
            (id,journal_entry_id,ledger_account_id,debit_minor,credit_minor,currency,description,created_at)
            VALUES (?,?,?,?,?,?, 'Credit card payment', ?)`,
          args:[randomUUID(),entryId,line.ledgerAccountId,Number(line.debitMinor),
            Number(line.creditMinor),String(card.rows[0].currency),now],
        });
      }
      await transaction.execute({
        sql:`INSERT INTO transactions
          (id,user_id,journal_entry_id,transaction_type,amount_minor,currency,account_id,
           description,transaction_at,status,source_type,idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'posted','credit_card_payment',?,?,?)`,
        args:[transactionId,user.userId,entryId,"transfer",body.amountMinor,
          String(card.rows[0].currency),body.paymentAccountId,"Credit card bill payment",
          body.paymentAt,body.idempotencyKey,now,now],
      });
      await transaction.commit();
      reply.code(201).send({ id:transactionId,journalEntryId:entryId,duplicate:false });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/users/me", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT id,email,display_name,default_currency,country,time_zone,status,created_at
            FROM users WHERE id = ?`,
      args: [user.userId],
    });
    return { user: result.rows[0] };
  });

  app.patch("/api/v1/users/me", async (request) => {
    const user = request.user!;
    const body = z.object({
      displayName: z.string().trim().min(1).max(100).optional(),
      defaultCurrency: z.string().length(3).optional(),
      country: z.string().trim().max(100).optional(),
      timeZone: z.string().trim().max(100).optional(),
    }).parse(request.body);
    await db.execute({
      sql: `UPDATE users SET display_name = COALESCE(?, display_name),
                   default_currency = COALESCE(?, default_currency),
                   country = COALESCE(?, country), time_zone = COALESCE(?, time_zone),
                   updated_at = ? WHERE id = ?`,
      args: [body.displayName ?? null, body.defaultCurrency?.toUpperCase() ?? null,
        body.country ?? null, body.timeZone ?? null, new Date().toISOString(), user.userId],
    });
    return { status: "updated" };
  });

  app.get("/api/v1/accounts/:id", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `SELECT * FROM accounts WHERE id = ? AND user_id = ?`,
      args: [params.id, user.userId],
    });
    if (!result.rows.length) throw new AccountingValidationError("Account not found.");
    return { account: result.rows[0] };
  });

  app.patch("/api/v1/accounts/:id", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      institutionName: z.string().trim().max(100).nullable().optional(),
      maskedAccountNumber: z.string().trim().max(20).nullable().optional(),
    }).parse(request.body);
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE accounts SET name = COALESCE(?,name),
                   institution_name = COALESCE(?,institution_name),
                   masked_account_number = COALESCE(?,masked_account_number),
                   updated_at = ? WHERE id = ? AND user_id = ?`,
      args: [body.name ?? null, body.institutionName ?? null,
        body.maskedAccountNumber ?? null, now, params.id, user.userId],
    });
    return { status: "updated" };
  });

  app.post("/api/v1/accounts/:id/archive", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    await db.execute({
      sql: `UPDATE accounts SET status='archived', updated_at=? WHERE id=? AND user_id=?`,
      args: [new Date().toISOString(), params.id, user.userId],
    });
    return { status: "archived" };
  });

  app.get("/api/v1/exports/transactions.csv", async (request, reply) => {
    const user = request.user!;
    const query = z.object({
      accountId: z.uuid().optional(),
      transactionType: z.enum(["income","expense","transfer"]).optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      status: z.enum(["posted","pending","reversed","rejected"]).optional(),
      categoryId: z.uuid().optional(),
      sourceType: z.string().trim().min(1).max(100).optional(),
      search: z.string().trim().max(100).optional(),
      sort: z.enum(["newest","oldest","highest","lowest"]).default("newest"),
    }).parse(request.query);
    if (query.from && query.to && query.from > query.to) {
      throw new AccountingValidationError("Start date must not be after end date.");
    }
    const searchAmount = query.search ? Number(query.search.replace(/[₹,\s]/g, "")) : Number.NaN;
    const searchAmountMinor = Number.isFinite(searchAmount) && Number.isSafeInteger(Math.round(searchAmount * 100))
      ? Math.round(searchAmount * 100)
      : null;
    const orderBy = {
      newest: "t.transaction_at DESC, t.created_at DESC",
      oldest: "t.transaction_at ASC, t.created_at ASC",
      highest: "t.amount_minor DESC, t.transaction_at DESC",
      lowest: "t.amount_minor ASC, t.transaction_at DESC",
    }[query.sort];
    const result = await db.execute({
      sql: `SELECT t.id,t.transaction_type,t.amount_minor,t.currency,a.name AS account_name,
                   c.name AS category_name,p.display_name AS payee_name,t.description,
                   t.transaction_at,t.status,t.source_type,t.source_reference
            FROM transactions t
            JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id
            LEFT JOIN categories c ON c.id=t.category_id
              AND (c.user_id=t.user_id OR c.user_id IS NULL)
            LEFT JOIN payees p ON p.id=t.payee_id AND p.user_id=t.user_id
            WHERE t.user_id=?
              AND (? IS NULL OR t.account_id=?)
              AND (? IS NULL OR t.transaction_type=?)
              AND (? IS NULL OR substr(t.transaction_at,1,10)>=?)
              AND (? IS NULL OR substr(t.transaction_at,1,10)<=?)
              AND (? IS NULL OR t.status=?)
              AND (? IS NULL OR t.category_id=?)
              AND (? IS NULL OR t.source_type=?)
              AND (? IS NULL OR t.description LIKE '%' || ? || '%'
                OR a.name LIKE '%' || ? || '%'
                OR c.name LIKE '%' || ? || '%'
                OR p.display_name LIKE '%' || ? || '%'
                OR t.source_reference LIKE '%' || ? || '%'
                OR (? IS NOT NULL AND t.amount_minor=?))
            ORDER BY ${orderBy}`,
      args: [user.userId,query.accountId ?? null,query.accountId ?? null,
        query.transactionType ?? null,query.transactionType ?? null,
        query.from ?? null,query.from ?? null,query.to ?? null,query.to ?? null,
        query.status ?? null,query.status ?? null,query.categoryId ?? null,query.categoryId ?? null,
        query.sourceType ?? null,query.sourceType ?? null,
        query.search ?? null,query.search ?? null,query.search ?? null,query.search ?? null,
        query.search ?? null,searchAmountMinor,searchAmountMinor],
    });
    const headers = [
      "transaction_id","type","amount_minor","currency","account","category","payee",
      "description","transaction_at","status","source","external_reference",
    ];
    const cell = (value: unknown) => {
      const text = value == null ? "" : String(value);
      const safe = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = result.rows.map((row) => [
      row.id,row.transaction_type,row.amount_minor,row.currency,row.account_name,
      row.category_name,row.payee_name,row.description,row.transaction_at,row.status,
      row.source_type,row.source_reference,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
    return reply
      .header("Content-Type","text/csv; charset=utf-8")
      .header("Content-Disposition",'attachment; filename="transactions.csv"')
      .send(csv);
  });

  app.get("/api/v1/transactions/:id", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `SELECT * FROM transactions WHERE id=? AND user_id=?`,
      args: [params.id, user.userId],
    });
    if (!result.rows.length) throw new AccountingValidationError("Transaction not found.");
    return { transaction: result.rows[0] };
  });

  app.patch("/api/v1/transactions/:id", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      description: z.string().trim().max(500).nullable().optional(),
      categoryId: z.uuid().nullable().optional(),
      payeeId: z.uuid().nullable().optional(),
    }).refine((value) => Object.keys(value).length > 0, {
      message: "At least one metadata field is required.",
    }).parse(request.body);
    const transaction = await db.transaction("write");
    try {
      const current = await transaction.execute({
        sql: `SELECT id,transaction_type,status,description,category_id,payee_id
              FROM transactions WHERE id=? AND user_id=?`,
        args: [params.id,user.userId],
      });
      if (!current.rows.length) throw new AccountingValidationError("Transaction not found.");
      const original = current.rows[0];
      if (original.status !== "posted" && original.status !== "pending") {
        throw new AccountingValidationError("Only posted or pending transaction metadata can be edited.");
      }

      if (body.categoryId) {
        const category = await transaction.execute({
          sql: `SELECT id FROM categories WHERE id=? AND (user_id=? OR user_id IS NULL)
                AND status='active' AND category_type=?`,
          args: [body.categoryId,user.userId,original.transaction_type],
        });
        if (!category.rows.length) throw new AccountingValidationError("Category not found or incompatible with this transaction.");
      }
      if (body.payeeId) {
        const payee = await transaction.execute({
          sql: `SELECT id FROM payees WHERE id=? AND user_id=?`,
          args: [body.payeeId,user.userId],
        });
        if (!payee.rows.length) throw new AccountingValidationError("Payee not found.");
      }

      const before = {
        description: original.description,
        categoryId: original.category_id,
        payeeId: original.payee_id,
      };
      const updates: string[] = [];
      const values: Array<string | null> = [];
      if (body.description !== undefined) {
        updates.push("description=?");
        values.push(body.description);
      }
      if (body.categoryId !== undefined) {
        updates.push("category_id=?");
        values.push(body.categoryId);
      }
      if (body.payeeId !== undefined) {
        updates.push("payee_id=?");
        values.push(body.payeeId);
      }
      const now = new Date().toISOString();
      updates.push("updated_at=?");
      values.push(now,params.id,user.userId);
      await transaction.execute({
        sql: `UPDATE transactions SET ${updates.join(",")} WHERE id=? AND user_id=?`,
        args: values,
      });
      const after = {
        description: body.description === undefined ? original.description : body.description,
        categoryId: body.categoryId === undefined ? original.category_id : body.categoryId,
        payeeId: body.payeeId === undefined ? original.payee_id : body.payeeId,
      };
      await transaction.execute({
        sql: `INSERT INTO audit_log
          (id,user_id,actor_id,entity_type,entity_id,action,before_data,after_data,request_id,created_at)
          VALUES (?,?,?,'transaction',?,'metadata_updated',?,?,?,?)`,
        args: [randomUUID(),user.userId,user.userId,params.id,JSON.stringify(before),JSON.stringify(after),request.id,now],
      });
      await transaction.commit();
      return { status: "updated", transactionId: params.id };
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/transactions/:id/audit", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const owned = await db.execute({
      sql: `SELECT id FROM transactions WHERE id=? AND user_id=?`,
      args: [params.id,user.userId],
    });
    if (!owned.rows.length) throw new AccountingValidationError("Transaction not found.");
    const result = await db.execute({
      sql: `SELECT action,before_data,after_data,request_id,created_at
            FROM audit_log WHERE entity_type='transaction' AND entity_id=? AND user_id=?
            ORDER BY created_at DESC LIMIT 100`,
      args: [params.id,user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/transactions/:id/reverse", async (request, reply) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const transaction = await db.transaction("write");
    try {
      const original = await transaction.execute({
        sql: `SELECT je.id AS entry_id, je.description, je.effective_at
              FROM transactions t JOIN journal_entries je ON je.id=t.journal_entry_id
              WHERE t.id=? AND t.user_id=? AND t.status='posted' AND je.status='posted'`,
        args: [params.id, user.userId],
      });
      if (!original.rows.length) throw new AccountingValidationError("Posted transaction not found.");

      const lines = await transaction.execute({
        sql: `SELECT ledger_account_id,debit_minor,credit_minor,currency,description
              FROM journal_lines WHERE journal_entry_id=?`,
        args: [String(original.rows[0].entry_id)],
      });
      if (!lines.rows.length) throw new AccountingValidationError("Original journal has no lines.");
      const now = new Date().toISOString();
      const reversalEntryId = randomUUID();
      const reversalNumber = `RV-${now.replace(/\D/g,"").slice(0,14)}-${randomUUID().slice(0,8)}`;
      await transaction.execute({
        sql: `INSERT INTO journal_entries
          (id,user_id,entry_number,description,effective_at,source_type,source_id,status,reversal_of_entry_id,created_at,posted_at)
          VALUES (?,?,?, 'Reversal', ?, 'reversal', ?, 'posted', ?, ?, ?)`,
        args: [reversalEntryId,user.userId,reversalNumber,original.rows[0].effective_at,
          params.id,original.rows[0].entry_id,now,now],
      });
      for (const line of lines.rows) {
        await transaction.execute({
          sql: `INSERT INTO journal_lines
            (id,journal_entry_id,ledger_account_id,debit_minor,credit_minor,currency,description,created_at)
            VALUES (?,?,?,?,?,?, 'Reversal', ?)`,
          args: [randomUUID(),reversalEntryId,String(line.ledger_account_id),
            Number(line.credit_minor),Number(line.debit_minor),String(line.currency),now],
        });
      }
      await transaction.execute({
        sql: `UPDATE transactions SET status='reversed',updated_at=? WHERE id=? AND user_id=?`,
        args: [now,params.id,user.userId],
      });
      await transaction.commit();
      reply.code(201).send({ reversalJournalEntryId: reversalEntryId, transactionId: params.id });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/reports/income", async (request) => {
    const user = request.user!;
    const query = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(request.query);
    if (query.from && query.to && query.from > query.to) {
      throw new AccountingValidationError("Start date must not be after end date.");
    }
    const result = await db.execute({
      sql: `SELECT transaction_at, SUM(amount_minor) AS amount_minor
            FROM transactions WHERE user_id=? AND transaction_type='income' AND status='posted'
              AND (? IS NULL OR substr(transaction_at,1,10)>=?)
              AND (? IS NULL OR substr(transaction_at,1,10)<=?)
            GROUP BY substr(transaction_at,1,10) ORDER BY transaction_at DESC`,
      args: [user.userId,query.from ?? null,query.from ?? null,query.to ?? null,query.to ?? null],
    });
    return { items: result.rows };
  });

  app.get("/api/v1/reports/expenses", async (request) => {
    const user = request.user!;
    const query = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(request.query);
    if (query.from && query.to && query.from > query.to) {
      throw new AccountingValidationError("Start date must not be after end date.");
    }
    const result = await db.execute({
      sql: `SELECT transaction_at, SUM(amount_minor) AS amount_minor
            FROM transactions WHERE user_id=? AND transaction_type='expense' AND status='posted'
              AND (? IS NULL OR substr(transaction_at,1,10)>=?)
              AND (? IS NULL OR substr(transaction_at,1,10)<=?)
            GROUP BY substr(transaction_at,1,10) ORDER BY transaction_at DESC`,
      args: [user.userId,query.from ?? null,query.from ?? null,query.to ?? null,query.to ?? null],
    });
    return { items: result.rows };
  });

  app.get("/api/v1/reports/categories", async (request) => {
    const user = request.user!;
    const query = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(request.query);
    if (query.from && query.to && query.from > query.to) {
      throw new AccountingValidationError("Start date must not be after end date.");
    }
    const result = await db.execute({
      sql: `SELECT t.category_id,COALESCE(c.name,'Uncategorized') AS category_name,
                   t.currency,SUM(t.amount_minor) AS amount_minor,COUNT(*) AS transaction_count
            FROM transactions t
            LEFT JOIN categories c ON c.id=t.category_id
              AND (c.user_id=t.user_id OR c.user_id IS NULL)
            WHERE t.user_id=? AND t.transaction_type='expense' AND t.status='posted'
              AND (? IS NULL OR substr(t.transaction_at,1,10)>=?)
              AND (? IS NULL OR substr(t.transaction_at,1,10)<=?)
            GROUP BY t.category_id,COALESCE(c.name,'Uncategorized'),t.currency
            ORDER BY amount_minor DESC,category_name ASC`,
      args: [user.userId,query.from ?? null,query.from ?? null,query.to ?? null,query.to ?? null],
    });
    return { items: result.rows };
  });

  app.get("/api/v1/reports/cash-flow", async (request) => {
    const user = request.user!;
    const query = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(request.query);
    if (query.from && query.to && query.from > query.to) {
      throw new AccountingValidationError("Start date must not be after end date.");
    }
    const result = await db.execute({
      sql: `SELECT substr(transaction_at,1,10) AS date,currency,
                   SUM(CASE WHEN transaction_type='income' THEN amount_minor ELSE 0 END) AS income_minor,
                   SUM(CASE WHEN transaction_type='expense' THEN amount_minor ELSE 0 END) AS expense_minor
            FROM transactions
            WHERE user_id=? AND status='posted' AND transaction_type IN ('income','expense')
              AND (? IS NULL OR substr(transaction_at,1,10)>=?)
              AND (? IS NULL OR substr(transaction_at,1,10)<=?)
            GROUP BY substr(transaction_at,1,10),currency
            ORDER BY date DESC,currency`,
      args: [user.userId,query.from ?? null,query.from ?? null,query.to ?? null,query.to ?? null],
    });
    return {
      items: result.rows.map((row) => ({
        ...row,
        net_minor: Number(row.income_minor) - Number(row.expense_minor),
      })),
    };
  });

  app.get("/api/v1/reports/net-worth", async (request) => {
    const summary = await app.inject({
      method: "GET",
      url: "/api/v1/reports/summary",
      headers: { authorization: request.headers.authorization },
    });
    return summary.json();
  });

  app.get("/api/v1/budgets/:id/performance", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const budget = await db.execute({
      sql: `SELECT * FROM budgets WHERE id=? AND user_id=? AND status='active'`,
      args: [params.id, user.userId],
    });
    if (!budget.rows.length) throw new AccountingValidationError("Budget not found.");
    const row = budget.rows[0];
    const spending = await db.execute({
      sql: `SELECT COALESCE(SUM(amount_minor),0) AS spending_minor
            FROM transactions
            WHERE user_id=? AND transaction_type='expense' AND status='posted'
              AND UPPER(currency)=UPPER(?)
              AND (
                NOT EXISTS (SELECT 1 FROM budget_categories WHERE budget_id=?)
                OR EXISTS (
                  SELECT 1 FROM budget_categories bc
                  WHERE bc.budget_id=? AND bc.category_id=transactions.category_id
                )
              )
              AND substr(transaction_at,1,10) BETWEEN ? AND ?`,
      args: [user.userId, String(row.currency), params.id, params.id,
        String(row.start_date), String(row.end_date)],
    });
    const spent = Number(spending.rows[0]?.spending_minor ?? 0);
    const limit = Number(row.total_limit_minor);
    const allocations = await db.execute({
      sql: `SELECT bc.category_id,c.name,bc.limit_minor,
                   COALESCE(SUM(t.amount_minor),0) AS spent_minor
            FROM budget_categories bc
            JOIN categories c ON c.id=bc.category_id
            LEFT JOIN transactions t
              ON t.user_id=? AND t.category_id=bc.category_id
             AND t.transaction_type='expense' AND t.status='posted'
             AND UPPER(t.currency)=UPPER(?)
             AND substr(t.transaction_at,1,10) BETWEEN ? AND ?
            WHERE bc.budget_id=?
            GROUP BY bc.id`,
      args: [user.userId,String(row.currency),String(row.start_date),String(row.end_date),params.id],
    });
    return {
      budgetId: params.id,
      limitMinor: limit,
      spentMinor: spent,
      remainingMinor: limit - spent,
      utilizationPercent: limit === 0 ? 0 : (spent * 100) / limit,
      categoryAllocations: allocations.rows.map((allocation) => {
        const allocationLimit = Number(allocation.limit_minor);
        const allocationSpent = Number(allocation.spent_minor);
        return {
          categoryId: String(allocation.category_id),
          categoryName: String(allocation.name),
          limitMinor: allocationLimit,
          spentMinor: allocationSpent,
          remainingMinor: allocationLimit - allocationSpent,
          utilizationPercent: allocationLimit === 0 ? 0 : (allocationSpent * 100) / allocationLimit,
        };
      }),
    };
  });

  app.get("/api/v1/installments", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT * FROM installments WHERE user_id=? ORDER BY due_date`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/installments/:id/payment", async (request, reply) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      paymentAccountId: z.uuid(),
      principalMinor: z.number().int().nonnegative(),
      interestMinor: z.number().int().nonnegative(),
      feesMinor: z.number().int().nonnegative().default(0),
      paymentAt: z.iso.datetime().default(() => new Date().toISOString()),
      idempotencyKey: z.string().trim().min(1).max(128),
    }).parse(request.body);
    const total = body.principalMinor + body.interestMinor + body.feesMinor;
    if (total <= 0) throw new AccountingValidationError("Payment amount must be greater than zero.");
    const installment = await db.execute({
      sql: `SELECT i.*,l.account_id, a.currency AS loan_currency
            FROM installments i JOIN loans l ON l.id=i.loan_id AND l.user_id=i.user_id
            JOIN accounts a ON a.id=l.account_id AND a.user_id=l.user_id
            WHERE i.id=? AND i.user_id=? AND i.status IN ('scheduled','partial','overdue')`,
      args: [params.id,user.userId],
    });
    const payment = await db.execute({
      sql: `SELECT a.currency,l.id AS ledger_id FROM accounts a
            JOIN chart_of_accounts l ON l.linked_financial_account_id=a.id AND l.user_id=a.user_id
            WHERE a.id=? AND a.user_id=? AND a.status='active'`,
      args: [body.paymentAccountId,user.userId],
    });
    if (!installment.rows.length || !payment.rows.length) throw new AccountingValidationError("Installment or payment account not found.");
    const row=installment.rows[0];
    if (String(row.loan_currency)!==String(payment.rows[0].currency)) {
      throw new AccountingValidationError("EMI payment currency must match the loan and payment account.");
    }
    if (total + Number(row.paid_total_minor) > Number(row.scheduled_total_minor)) {
      throw new AccountingValidationError("Payment exceeds the remaining scheduled installment amount.");
    }
    const loanLedger=await db.execute({
      sql:`SELECT id FROM chart_of_accounts WHERE user_id=? AND linked_financial_account_id=?`,
      args:[user.userId,String(row.account_id)],
    });
    const expenseLedger=await db.execute({
      sql:`SELECT id FROM chart_of_accounts WHERE user_id=? AND account_class='expense' AND status='active' LIMIT 1`,
      args:[user.userId],
    });
    if (!loanLedger.rows.length || !expenseLedger.rows.length) throw new AccountingValidationError("Loan or expense ledger account is missing.");

    const transaction = await db.transaction("write");
    try {
      const duplicate=await transaction.execute({
        sql:`SELECT id,journal_entry_id FROM transactions WHERE user_id=? AND idempotency_key=?`,
        args:[user.userId,body.idempotencyKey],
      });
      if (duplicate.rows.length) {
        await transaction.commit();
        return reply.send({ id:duplicate.rows[0].id,journalEntryId:duplicate.rows[0].journal_entry_id,duplicate:true });
      }
      const entryId=randomUUID();
      const transactionId=randomUUID();
      const now=new Date().toISOString();
      const lines=[
        ...(body.principalMinor>0 ? [{ledgerAccountId:String(loanLedger.rows[0].id),debitMinor:BigInt(body.principalMinor),creditMinor:0n}] : []),
        ...(body.interestMinor+body.feesMinor>0 ? [{ledgerAccountId:String(expenseLedger.rows[0].id),debitMinor:BigInt(body.interestMinor+body.feesMinor),creditMinor:0n}] : []),
        {ledgerAccountId:String(payment.rows[0].ledger_id),debitMinor:0n,creditMinor:BigInt(total)},
      ];
      validateJournalLines(lines);
      const entryNumber=`EMI-${now.replace(/\D/g,"").slice(0,14)}-${randomUUID().slice(0,8)}`;
      await transaction.execute({
        sql:`INSERT INTO journal_entries
          (id,user_id,entry_number,description,effective_at,source_type,source_id,status,created_at,posted_at)
          VALUES (?,?,?,'Installment payment',?,'installment_payment',?,'posted',?,?)`,
        args:[entryId,user.userId,entryNumber,body.paymentAt,transactionId,now,now],
      });
      for (const line of lines) {
        await transaction.execute({
          sql:`INSERT INTO journal_lines
            (id,journal_entry_id,ledger_account_id,debit_minor,credit_minor,currency,description,created_at)
            VALUES (?,?,?,?,?,?, 'Installment payment', ?)`,
          args:[randomUUID(),entryId,line.ledgerAccountId,Number(line.debitMinor),
            Number(line.creditMinor),String(row.loan_currency),now],
        });
      }
      await transaction.execute({
        sql:`INSERT INTO transactions
          (id,user_id,journal_entry_id,transaction_type,amount_minor,currency,account_id,
           description,transaction_at,status,source_type,idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'posted','installment_payment',?,?,?)`,
        args:[transactionId,user.userId,entryId,"transfer",total,String(row.loan_currency),
          body.paymentAccountId,`EMI payment #${String(row.installment_number)}`,
          body.paymentAt,body.idempotencyKey,now,now],
      });
      const paid=Number(row.paid_total_minor)+total;
      await transaction.execute({
        sql:`UPDATE installments SET paid_total_minor=?,status=?,actual_payment_date=?,updated_at=? WHERE id=? AND user_id=?`,
        args:[paid,paid===Number(row.scheduled_total_minor)?"paid":"partial",
          body.paymentAt,now,params.id,user.userId],
      });
      await transaction.commit();
      reply.code(201).send({ id:transactionId,journalEntryId:entryId,paidTotalMinor:paid });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/loans/:id/schedule", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const loan = await db.execute({
      sql: `SELECT id FROM loans WHERE id=? AND user_id=?`,
      args: [params.id,user.userId],
    });
    if (!loan.rows.length) throw new AccountingValidationError("Loan not found.");
    const installments = await db.execute({
      sql: `SELECT * FROM installments WHERE loan_id=? AND user_id=? ORDER BY installment_number`,
      args: [params.id,user.userId],
    });
    return { items: installments.rows };
  });

  app.post("/api/v1/loans/:id/schedule", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      principalMinor: z.number().int().positive().safe(),
      annualInterestPercent: z.number().min(0).max(100),
      tenureMonths: z.number().int().positive().max(600),
    }).parse(request.body);
    const transaction = await db.transaction("write");
    try {
      const loanResult = await transaction.execute({
        sql: `SELECT id,start_date,original_principal_minor,tenure_months
              FROM loans WHERE id=? AND user_id=? AND status='active'`,
        args: [params.id,user.userId],
      });
      if (!loanResult.rows.length) throw new AccountingValidationError("Loan not found.");
      const loan = loanResult.rows[0];
      if (body.principalMinor !== Number(loan.original_principal_minor)) {
        throw new AccountingValidationError("Schedule principal must match the loan's original principal.");
      }
      if (loan.tenure_months !== null && body.tenureMonths !== Number(loan.tenure_months)) {
        throw new AccountingValidationError("Schedule tenure must match the loan's configured tenure.");
      }
      const existing = await transaction.execute({
        sql: `SELECT id FROM installments WHERE loan_id=? AND user_id=? LIMIT 1`,
        args: [params.id,user.userId],
      });
      if (existing.rows.length) throw new AccountingValidationError("A repayment schedule already exists for this loan.");
    const monthlyRate = body.annualInterestPercent / 12 / 100;
    const emi = monthlyRate === 0
      ? Math.round(body.principalMinor / body.tenureMonths)
      : Math.round(body.principalMinor * monthlyRate * Math.pow(1 + monthlyRate, body.tenureMonths)
        / (Math.pow(1 + monthlyRate, body.tenureMonths) - 1));
    let outstanding = body.principalMinor;
    const start = new Date(`${String(loan.start_date)}T00:00:00.000Z`);
    const now = new Date().toISOString();
    for (let index = 1; index <= body.tenureMonths; index++) {
      const interest = Math.round(outstanding * monthlyRate);
      const principal = index === body.tenureMonths ? outstanding : Math.min(outstanding, emi - interest);
      const dueMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
      const lastDay = new Date(Date.UTC(dueMonth.getUTCFullYear(), dueMonth.getUTCMonth() + 1, 0)).getUTCDate();
      dueMonth.setUTCDate(Math.min(start.getUTCDate(), lastDay));
      const total = principal + interest;
      await transaction.execute({
        sql: `INSERT INTO installments
          (id,user_id,loan_id,installment_number,due_date,scheduled_principal_minor,
           scheduled_interest_minor,scheduled_fees_minor,scheduled_total_minor,
           paid_total_minor,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,'scheduled',?,?)`,
        args: [randomUUID(),user.userId,params.id,index,dueMonth.toISOString().slice(0,10),
          principal,interest,0,total,now,now],
      });
      outstanding -= principal;
    }
      await transaction.commit();
    return { emiMinor: emi, tenureMonths: body.tenureMonths };
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/payees", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT * FROM payees WHERE user_id=? ORDER BY display_name`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/payees", async (request, reply) => {
    const user = request.user!;
    const body = z.object({ displayName: z.string().trim().min(1).max(100) }).parse(request.body);
    const now = new Date().toISOString();
    const id = randomUUID();
    const normalized = body.displayName.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    await db.execute({
      sql: `INSERT INTO payees (id,user_id,display_name,normalized_name,created_at,updated_at)
            VALUES (?,?,?,?,?,?)`,
      args: [id,user.userId,body.displayName,normalized,now,now],
    });
    reply.code(201).send({ id, displayName: body.displayName });
  });

  app.get("/api/v1/recurring-rules", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT * FROM recurring_rules WHERE user_id=? AND status='active'`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.post("/api/v1/recurring-rules", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      transactionType: z.enum(["income","expense"]),
      amountMinor: z.number().int().positive(),
      currency: z.string().length(3).default("INR"),
      accountId: z.uuid(),
      categoryId: z.uuid().optional(),
      frequency: z.enum(["daily","weekly","monthly","yearly"]),
      intervalValue: z.number().int().positive().default(1),
      startDate: z.iso.date(),
      endDate: z.iso.date().optional(),
      autoPostPolicy: z.literal("manual_confirmation").default("manual_confirmation"),
    }).parse(request.body);
    const account = await db.execute({
      sql: `SELECT id,currency FROM accounts WHERE id=? AND user_id=? AND status='active'`,
      args: [body.accountId,user.userId],
    });
    if (!account.rows.length) throw new AccountingValidationError("Account not found.");
    if (String(account.rows[0].currency).toUpperCase() !== body.currency.toUpperCase()) {
      throw new AccountingValidationError("Recurring rule currency must match its account.");
    }
    if (body.endDate && body.endDate < body.startDate) {
      throw new AccountingValidationError("Recurring end date must not precede start date.");
    }
    if (body.categoryId) {
      const category = await db.execute({
        sql: `SELECT id FROM categories WHERE id=? AND (user_id=? OR user_id IS NULL)
              AND status='active' AND category_type=?`,
        args: [body.categoryId,user.userId,body.transactionType],
      });
      if (!category.rows.length) throw new AccountingValidationError("Recurring category not found or incompatible.");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO recurring_rules
        (id,user_id,transaction_type,amount_minor,currency,account_id,category_id,
         frequency,interval_value,start_date,end_date,next_occurrence,auto_post_policy,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      args: [id,user.userId,body.transactionType,body.amountMinor,body.currency.toUpperCase(),
        body.accountId,body.categoryId ?? null,body.frequency,body.intervalValue,body.startDate,
        body.endDate ?? null,body.startDate,body.autoPostPolicy,now,now],
    });
    reply.code(201).send({ id, ...body, status: "active" });
  });

  app.post("/api/v1/recurring-rules/:id/archive", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `UPDATE recurring_rules SET status='archived',updated_at=?
            WHERE id=? AND user_id=? AND status='active'`,
      args: [new Date().toISOString(),params.id,user.userId],
    });
    if (Number(result.rowsAffected) !== 1) throw new AccountingValidationError("Recurring rule not found.");
    return { status: "archived", id: params.id };
  });

  app.post("/api/v1/imports", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      accountId: z.uuid(),
      fileName: z.string().trim().min(1).max(255),
      fileType: z.enum(["csv","xls","xlsx","pdf"]),
      fileHash: z.string().trim().min(8).max(128),
      rows: z.array(z.object({
        rowNumber: z.number().int().positive(),
        description: z.string().max(500).optional(),
        transactionDate: z.string().max(50).optional(),
        debitMinor: z.number().int().nonnegative().default(0),
        creditMinor: z.number().int().nonnegative().default(0),
        balanceMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
        externalReference: z.string().max(200).optional(),
      })).max(2000).default([]),
    }).parse(request.body);
    const account = await db.execute({
      sql: `SELECT id FROM accounts WHERE id=? AND user_id=?`,
      args: [body.accountId,user.userId],
    });
    if (!account.rows.length) throw new AccountingValidationError("Account not found.");
    const previousBatch = await db.execute({
      sql: `SELECT id,status FROM import_batches
            WHERE user_id=? AND account_id=? AND file_hash=? ORDER BY created_at DESC LIMIT 1`,
      args: [user.userId,body.accountId,body.fileHash],
    });
    if (previousBatch.rows.length) {
      return reply.send({
        id: previousBatch.rows[0].id,
        status: previousBatch.rows[0].status,
        duplicate: true,
      });
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const transaction = await db.transaction("write");
    try {
      await transaction.execute({
        sql: `INSERT INTO import_batches
          (id,user_id,account_id,file_name,file_type,file_hash,status,total_rows,created_at)
          VALUES (?,?,?,?,?,?,'draft',?,?)`,
        args: [id,user.userId,body.accountId,body.fileName,body.fileType,
          body.fileHash,body.rows.length,now],
      });
      for (const row of body.rows) {
        await transaction.execute({
          sql: `INSERT INTO import_rows
            (id,import_batch_id,row_number,raw_description,normalized_description,transaction_date,
             debit_minor,credit_minor,balance_minor,external_reference,parsed_data)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          args: [randomUUID(),id,row.rowNumber,row.description ?? null,
            row.description?.toLowerCase().trim() ?? null,row.transactionDate ?? null,
            row.debitMinor,row.creditMinor,row.balanceMinor ?? null,row.externalReference ?? null,
            JSON.stringify(row)],
        });
      }
      await transaction.commit();
      reply.code(201).send({ id, status: "draft", totalRows: body.rows.length });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  });

  app.get("/api/v1/imports", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `SELECT * FROM import_batches WHERE user_id=? ORDER BY created_at DESC`,
      args: [user.userId],
    });
    return { items: result.rows };
  });

  app.get("/api/v1/imports/:id/preview", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const batch = await db.execute({
      sql: `SELECT b.*,a.account_type,a.currency AS account_currency FROM import_batches b
            JOIN accounts a ON a.id=b.account_id AND a.user_id=b.user_id
            WHERE b.id=? AND b.user_id=?`,
      args: [params.id,user.userId],
    });
    if (!batch.rows.length) throw new AccountingValidationError("Import batch not found.");
    const rows = await db.execute({
      sql: `SELECT * FROM import_rows WHERE import_batch_id=? ORDER BY row_number`,
      args: [params.id],
    });
    const reconciliation = reconcileImportBalances(rows.rows.map((row) => ({
      row_number: Number(row.row_number),
      debit_minor: Number(row.debit_minor),
      credit_minor: Number(row.credit_minor),
      balance_minor: row.balance_minor === null || row.balance_minor === undefined
        ? null
        : Number(row.balance_minor),
    })), String(batch.rows[0].account_type));
    return { batch: batch.rows[0], rows: rows.rows, reconciliation };
  });

  app.get("/api/v1/imports/:id", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `SELECT * FROM import_batches WHERE id=? AND user_id=?`,
      args: [params.id,user.userId],
    });
    if (!result.rows.length) throw new AccountingValidationError("Import batch not found.");
    return { batch: result.rows[0] };
  });

  app.post("/api/v1/imports/:id/rows/:rowId/approve", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid(),rowId: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `UPDATE import_rows SET validation_status='approved'
            WHERE id=? AND import_batch_id=?
              AND EXISTS(SELECT 1 FROM import_batches WHERE id=? AND user_id=?)`,
      args: [params.rowId,params.id,params.id,user.userId],
    });
    if (Number(result.rowsAffected) !== 1) throw new AccountingValidationError("Import row not found.");
    return { rowId: params.rowId,status: "approved" };
  });

  app.post("/api/v1/imports/:id/confirm", async (request, reply) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const batch = await db.execute({
      sql: `SELECT b.*,a.currency AS account_currency
            FROM import_batches b JOIN accounts a ON a.id=b.account_id AND a.user_id=b.user_id
            WHERE b.id=? AND b.user_id=? AND b.status='draft'`,
      args: [params.id,user.userId],
    });
    if (!batch.rows.length) throw new AccountingValidationError("Draft import batch not found.");
    const rows = await db.execute({
      sql: `SELECT * FROM import_rows WHERE import_batch_id=? AND validation_status='approved'
            ORDER BY row_number`,
      args: [params.id],
    });
    if (!rows.rows.length) throw new AccountingValidationError("Approve at least one valid row before confirming.");

    let accepted = 0;
    let duplicates = 0;
    for (const row of rows.rows) {
      const debit = Number(row.debit_minor);
      const credit = Number(row.credit_minor);
      if ((debit > 0) === (credit > 0)) {
        await db.execute({
          sql: `UPDATE import_rows SET validation_status='rejected' WHERE id=?`,
          args: [String(row.id)],
        });
        continue;
      }
      const externalReference = row.external_reference ? String(row.external_reference) : null;
      if (externalReference) {
        const duplicate = await db.execute({
          sql: `SELECT id FROM external_transaction_refs
                WHERE account_id=? AND source='bank_import' AND external_reference=?`,
          args: [String(batch.rows[0].account_id),externalReference],
        });
        if (duplicate.rows.length) {
          duplicates++;
          await db.execute({
            sql: `UPDATE import_rows SET duplicate_status='duplicate',validation_status='duplicate'
                  WHERE id=?`,
            args: [String(row.id)],
          });
          continue;
        }
      }
      const dateText = row.transaction_date ? String(row.transaction_date) : "";
      const parsedDate = parseImportDate(dateText);
      if (!parsedDate) {
        await db.execute({
          sql: `UPDATE import_rows SET validation_status='rejected' WHERE id=?`,
          args: [String(row.id)],
        });
        continue;
      }
      const date = parsedDate.toISOString();
      const transactionType = debit > 0 ? "expense" : "income";
      const amountMinor = debit > 0 ? debit : credit;
      const idempotencyKey = externalReference
        ? `bank-import:${String(batch.rows[0].account_id)}:${externalReference}`
        : `bank-import:${params.id}:${String(row.id)}`;
      const injected = await app.inject({
        method: "POST",
        url: "/api/v1/transactions",
        headers: {
          authorization: request.headers.authorization ?? "",
          "content-type": "application/json",
        },
        payload: {
          transactionType,
          amountMinor,
          currency: String(batch.rows[0].account_currency),
          accountId: String(batch.rows[0].account_id),
          description: String(row.raw_description ?? "Imported transaction"),
          transactionAt: date,
          idempotencyKey,
        },
      });
      if (injected.statusCode < 200 || injected.statusCode >= 300) {
        throw new AccountingValidationError(`Import row ${String(row.row_number)} failed posting validation.`);
      }
      const posted = injected.json() as { id: string };
      await db.execute({
        sql: `UPDATE import_rows SET validation_status='posted',linked_transaction_id=?
              WHERE id=?`,
        args: [posted.id,String(row.id)],
      });
      if (externalReference) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO external_transaction_refs
            (id,user_id,account_id,source,external_reference,transaction_id,created_at)
            VALUES (?,?,?,'bank_import',?,?,?)`,
          args: [randomUUID(),user.userId,String(batch.rows[0].account_id),
            externalReference,posted.id,new Date().toISOString()],
        });
      }
      accepted++;
    }
    const status = accepted > 0 ? "completed" : "completed_with_rejections";
    await db.execute({
      sql: `UPDATE import_batches SET status=?,accepted_rows=?,duplicate_rows=?,
                   rejected_rows=(SELECT COUNT(*) FROM import_rows WHERE import_batch_id=? AND validation_status='rejected'),
                   completed_at=? WHERE id=? AND user_id=?`,
      args: [status,accepted,duplicates,params.id,new Date().toISOString(),params.id,user.userId],
    });
    reply.send({ id: params.id,status,acceptedRows: accepted,duplicateRows: duplicates });
  });

  app.post("/api/v1/imports/:id/cancel", async (request) => {
    const user = request.user!;
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const result = await db.execute({
      sql: `UPDATE import_batches SET status='cancelled'
            WHERE id=? AND user_id=? AND status='draft'`,
      args: [params.id,user.userId],
    });
    if (Number(result.rowsAffected) !== 1) throw new AccountingValidationError("Draft import batch not found.");
    return { id: params.id,status:"cancelled" };
  });

  app.post("/api/v1/notification-events/confirm", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      candidateId: z.uuid(),
      deviceId: z.string().trim().min(1).max(128),
      sourcePackage: z.enum([
        "com.google.android.apps.nbu.paisa.user",
        "net.one97.paytm",
        "com.phonepe.app",
      ]),
      receivedAt: z.iso.datetime(),
      amountMinor: z.number().int().positive(),
      currency: z.string().length(3),
      direction: z.enum(["income","expense"]),
      description: z.string().trim().min(1).max(500),
      referenceHash: z.string().regex(/^[a-f0-9]{64}$/i),
      accountId: z.uuid(),
      categoryId: z.uuid().optional(),
      idempotencyKey: z.string().trim().min(1).max(128),
    }).parse(request.body);
    const fingerprint = createHash("sha256")
      .update(`${body.sourcePackage}:${body.referenceHash.toLowerCase()}`)
      .digest("hex");
    const reservation = await db.transaction("write");
    let eventId: string;
    try {
      const existing = await reservation.execute({
        sql: `SELECT id,processing_status,processing_started_at,linked_transaction_id FROM notification_events
              WHERE user_id=? AND candidate_fingerprint=?`,
        args: [user.userId,fingerprint],
      });
      if (existing.rows.length && existing.rows[0].processing_status === "posted") {
        await reservation.commit();
        return reply.send({
          id: existing.rows[0].id,
          transactionId: existing.rows[0].linked_transaction_id,
          duplicate: true,
        });
      }
      if (existing.rows.length && existing.rows[0].processing_status === "processing") {
        const alreadyPosted = await reservation.execute({
          sql: `SELECT id FROM transactions WHERE user_id=? AND idempotency_key=?`,
          args: [user.userId,`notification:${body.candidateId}`],
        });
        if (alreadyPosted.rows.length) {
          await reservation.execute({
            sql: `UPDATE notification_events SET processing_status='posted',linked_transaction_id=?,
                  processing_started_at=NULL WHERE id=? AND user_id=?`,
            args: [alreadyPosted.rows[0].id,String(existing.rows[0].id),user.userId],
          });
          await reservation.commit();
          return reply.send({
            id: existing.rows[0].id,
            transactionId: alreadyPosted.rows[0].id,
            duplicate: true,
          });
        }
        const startedAt = existing.rows[0].processing_started_at
          ? Date.parse(String(existing.rows[0].processing_started_at))
          : 0;
        if (startedAt > 0 && Date.now() - startedAt < 120_000) {
          await reservation.commit();
          return reply.code(409).send({ message: "This notification is already being confirmed." });
        }
      }
      const now = new Date().toISOString();
      eventId = existing.rows.length ? String(existing.rows[0].id) : randomUUID();
      if (existing.rows.length) {
        await reservation.execute({
          sql: `UPDATE notification_events SET processing_status='processing',processing_started_at=?,device_id=?,
                source_package=?,received_at=?,extracted_amount_minor=?,extracted_currency=?,
                extracted_direction=?,extracted_description=?,extracted_reference=?,extracted_status='confirmed'
                WHERE id=? AND user_id=?`,
          args: [now,body.deviceId,body.sourcePackage,body.receivedAt,body.amountMinor,
            body.currency.toUpperCase(),body.direction,body.description,body.referenceHash,
            eventId,user.userId],
        });
      } else {
        await reservation.execute({
          sql: `INSERT INTO notification_events
            (id,user_id,device_id,source_package,received_at,extracted_amount_minor,
             extracted_currency,extracted_direction,extracted_description,extracted_reference,
             candidate_fingerprint,extracted_status,processing_status,processing_started_at,retention_expiry)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'confirmed','processing',?,?)`,
          args: [eventId,user.userId,body.deviceId,body.sourcePackage,body.receivedAt,
            body.amountMinor,body.currency.toUpperCase(),body.direction,body.description,
            body.referenceHash,fingerprint,now,new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()],
        });
      }
      await reservation.commit();
    } catch (error) {
      await reservation.rollback();
      throw error;
    } finally {
      reservation.close();
    }

    const transactionKey = `notification:${body.candidateId}`;
    const posted = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: {
        authorization: request.headers.authorization ?? "",
        "content-type": "application/json",
      },
      payload: {
        transactionType: body.direction,
        amountMinor: body.amountMinor,
        currency: body.currency.toUpperCase(),
        accountId: body.accountId,
        ...(body.categoryId ? { categoryId: body.categoryId } : {}),
        description: body.description,
        transactionAt: body.receivedAt,
        idempotencyKey: transactionKey,
      },
    });
    if (posted.statusCode < 200 || posted.statusCode >= 300) {
      await db.execute({
        sql: `UPDATE notification_events SET processing_status='failed',processing_started_at=NULL
              WHERE id=? AND user_id=? AND processing_status='processing'`,
        args: [eventId,user.userId],
      });
      return reply.code(posted.statusCode).send(posted.json());
    }
    const transactionResult = posted.json() as { id: string; duplicate?: boolean };
    await db.execute({
      sql: `UPDATE notification_events SET processing_status='posted',linked_transaction_id=?,processing_started_at=NULL
            WHERE id=? AND user_id=?`,
      args: [transactionResult.id,eventId,user.userId],
    });
    reply.code(posted.statusCode === 200 ? 200 : 201).send({
      id: eventId,
      transactionId: transactionResult.id,
      duplicate: Boolean(transactionResult.duplicate),
    });
  });

  app.delete("/api/v1/notification-events", async (request) => {
    const user = request.user!;
    const result = await db.execute({
      sql: `DELETE FROM notification_events WHERE user_id=? AND processing_status!='processing'`,
      args: [user.userId],
    });
    return { deleted: Number(result.rowsAffected) };
  });

  app.post("/api/v1/notification-events/delete", async (request) => {
    const user = request.user!;
    z.object({ idempotencyKey: z.string().trim().min(1).max(128) }).parse(request.body);
    const result = await db.execute({
      sql: `DELETE FROM notification_events WHERE user_id=? AND processing_status!='processing'`,
      args: [user.userId],
    });
    return { deleted: Number(result.rowsAffected) };
  });

  app.post("/api/v1/sync/operations", async (request, reply) => {
    const user = request.user!;
    const body = z.object({
      deviceId: z.string().trim().min(1).max(128).optional(),
      idempotencyKey: z.string().trim().min(1).max(128),
      operationType: z.enum(["transaction","transfer","notification_confirmation","notification_delete"]),
      payload: z.record(z.string(), z.unknown()),
    }).parse(request.body);
    if (body.payload.idempotencyKey !== body.idempotencyKey) {
      throw new AccountingValidationError("Sync operation and payload idempotency keys must match.");
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ operationType: body.operationType,payload: body.payload }))
      .digest("hex");
    const existing = await db.execute({
      sql: `SELECT * FROM sync_operations WHERE user_id=? AND idempotency_key=?`,
      args: [user.userId,body.idempotencyKey],
    });
    const prior = existing.rows[0];
    if (prior) {
      if (String(prior.request_hash) !== requestHash) {
        return reply.code(409).send({ message: "This idempotency key was already used for a different sync operation." });
      }
      if (prior.status === "completed") {
        return reply.send({ id: prior.id,status:"duplicate",responseReference:prior.response_reference });
      }
    } else {
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT OR IGNORE INTO sync_operations
          (id,user_id,device_id,idempotency_key,operation_type,request_hash,status,created_at)
          VALUES (?,?,?,?,?,?,'processing',?)`,
        args: [randomUUID(),user.userId,body.deviceId ?? null,body.idempotencyKey,
          body.operationType,requestHash,now],
      });
      const inserted = await db.execute({
        sql: `SELECT id,request_hash,status FROM sync_operations WHERE user_id=? AND idempotency_key=?`,
        args: [user.userId,body.idempotencyKey],
      });
      if (!inserted.rows.length || String(inserted.rows[0].request_hash) !== requestHash) {
        return reply.code(409).send({ message: "This idempotency key conflicts with another sync operation." });
      }
    }
    const result = await app.inject({
      method: "POST",
      url: body.operationType === "transaction"
        ? "/api/v1/transactions"
        : body.operationType === "transfer"
          ? "/api/v1/transfers"
          : body.operationType === "notification_confirmation"
            ? "/api/v1/notification-events/confirm"
            : "/api/v1/notification-events/delete",
      headers: {
        authorization: request.headers.authorization ?? "",
        "content-type": "application/json",
      },
      payload: body.payload,
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      await db.execute({
        sql: `UPDATE sync_operations SET status='rejected' WHERE user_id=? AND idempotency_key=?`,
        args: [user.userId,body.idempotencyKey],
      });
      return reply.code(result.statusCode).send(result.json());
    }
    const response = result.json() as { id?: string };
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE sync_operations SET status='completed',response_reference=?,completed_at=?
            WHERE user_id=? AND idempotency_key=?`,
      args: [response.id ?? null,now,user.userId,body.idempotencyKey],
    });
    reply.code(result.statusCode === 200 ? 200 : 201).send({
      id: response.id,
      status: "completed",
      duplicate: result.statusCode === 200,
    });
  });

  return app;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: import("./auth.js").AuthUser;
  }
}
