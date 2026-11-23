import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "file::memory:?cache=shared";
process.env.JWT_SECRET = "integration-test-secret-that-is-long-enough";

const [{ buildApp }, { db }, { applySchema }] = await Promise.all([
  import("./app.js"),
  import("./db/client.js"),
  import("./db/schema.js"),
]);

const app = buildApp();

beforeAll(async () => {
  await applySchema(db);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
});

describe("API financial flow", () => {
  it("enables foreign-key enforcement before applying migrations", async () => {
    const result = await db.execute("PRAGMA foreign_keys");
    expect(Number(result.rows[0]?.foreign_keys)).toBe(1);
  });

  it("records the schema baseline migration only once", async () => {
    await applySchema(db);
    const result = await db.execute("SELECT version FROM schema_migrations");
    expect(result.rows.map((row) => Number(row.version))).toEqual([1]);
  });

  it("updates budget spending and import history as expenses are posted", async () => {
    const email = `finance-${randomUUID()}@example.test`;
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, displayName: "Integration Test", password: "SafePassphrase123!" },
    });
    expect(registration.statusCode).toBe(201);
    const { token } = registration.json<{ token: string }>();
    const authorization = { authorization: `Bearer ${token}` };

    const accountResponse = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: authorization,
      payload: {
        name: "Primary bank",
        accountType: "bank",
        currency: "INR",
        openingBalanceMinor: 3_500_000,
      },
    });
    expect(accountResponse.statusCode).toBe(201);
    const account = accountResponse.json<{ id: string }>();

    const today = new Date().toISOString().slice(0, 10);
    const budgetResponse = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      headers: authorization,
      payload: {
        name: "Monthly essentials",
        periodType: "monthly",
        startDate: today,
        endDate: today,
        totalLimitMinor: 100_000,
        currency: "INR",
      },
    });
    expect(budgetResponse.statusCode).toBe(201);
    const overallBudget = budgetResponse.json<{ id: string }>();

    const categoryResponse = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      headers: authorization,
      payload: { name: "Groceries", categoryType: "expense" },
    });
    expect(categoryResponse.statusCode).toBe(201);
    const category = categoryResponse.json<{ id: string }>();
    const recurringResponse = await app.inject({
      method: "POST",
      url: "/api/v1/recurring-rules",
      headers: authorization,
      payload: {
        transactionType: "expense",
        amountMinor: 5_000,
        currency: "INR",
        accountId: account.id,
        categoryId: category.id,
        frequency: "monthly",
        intervalValue: 1,
        startDate: today,
      },
    });
    expect(recurringResponse.statusCode).toBe(201);
    const recurringRule = recurringResponse.json<{ id: string }>();
    const recurringRules = await app.inject({
      method: "GET",
      url: "/api/v1/recurring-rules",
      headers: authorization,
    });
    expect(recurringRules.json<{ items: Array<{ id: string; auto_post_policy: string }> }>().items)
      .toContainEqual(expect.objectContaining({ id: recurringRule.id, auto_post_policy: "manual_confirmation" }));
    const invalidRecurringRule = await app.inject({
      method: "POST",
      url: "/api/v1/recurring-rules",
      headers: authorization,
      payload: {
        transactionType: "income",
        amountMinor: 5_000,
        currency: "INR",
        accountId: account.id,
        categoryId: category.id,
        frequency: "monthly",
        startDate: today,
      },
    });
    expect(invalidRecurringRule.statusCode).toBe(400);
    const categoryBudgetResponse = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      headers: authorization,
      payload: {
        name: "Food budget",
        periodType: "monthly",
        startDate: today,
        endDate: today,
        totalLimitMinor: 50_000,
        currency: "INR",
        categoryAllocations: [{ categoryId: category.id, limitMinor: 20_000 }],
      },
    });
    expect(categoryBudgetResponse.statusCode).toBe(201);
    const categoryBudget = categoryBudgetResponse.json<{ id: string }>();
    const budgetDetail = await app.inject({
      method: "GET",
      url: `/api/v1/budgets/${overallBudget.id}`,
      headers: authorization,
    });
    expect(budgetDetail.json<{ budget: { name: string } }>().budget.name).toBe("Monthly essentials");
    const budgetUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/budgets/${overallBudget.id}`,
      headers: authorization,
      payload: { name: "Essentials revised", totalLimitMinor: 120_000 },
    });
    expect(budgetUpdate.statusCode).toBe(200);
    const invalidBudgetUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/budgets/${categoryBudget.id}`,
      headers: authorization,
      payload: { totalLimitMinor: 10_000 },
    });
    expect(invalidBudgetUpdate.statusCode).toBe(400);
    const categoryBudgetUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/budgets/${categoryBudget.id}`,
      headers: authorization,
      payload: {
        totalLimitMinor: 55_000,
        categoryAllocations: [{ categoryId: category.id, limitMinor: 20_000 }],
      },
    });
    expect(categoryBudgetUpdate.statusCode).toBe(200);
    const invalidAllocation = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      headers: authorization,
      payload: {
        name: "Invalid budget",
        periodType: "monthly",
        startDate: today,
        endDate: today,
        totalLimitMinor: 10_000,
        currency: "INR",
        categoryAllocations: [{ categoryId: category.id, limitMinor: 10_001 }],
      },
    });
    expect(invalidAllocation.statusCode).toBe(400);

    const payload = {
      transactionType: "expense",
      amountMinor: 25_000,
      currency: "INR",
      accountId: account.id,
      categoryId: category.id,
      description: "Groceries",
      idempotencyKey: `expense-${randomUUID()}`,
    };
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/transactions", headers: authorization, payload }),
      app.inject({ method: "POST", url: "/api/v1/transactions", headers: authorization, payload }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(responses.map((response) => response.json<{ duplicate: boolean }>().duplicate).sort()).toEqual([false, true]);

    const balance = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${account.id}/balance`,
      headers: authorization,
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json<{ balanceMinor: number }>().balanceMinor).toBe(3_475_000);
    const filteredTransactions = await app.inject({
      method: "GET",
      url: `/api/v1/transactions?search=250.00&transactionType=expense&accountId=${account.id}&from=${today}&to=${today}&sort=highest`,
      headers: authorization,
    });
    expect(filteredTransactions.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id))
      .toEqual([responses.find((response) => response.statusCode === 201)!.json<{ id: string }>().id]);
    const report = await app.inject({
      method: "GET",
      url: `/api/v1/reports/summary?from=${today}&to=${today}`,
      headers: authorization,
    });
    expect(report.json<{ incomeMinor: number; expenseMinor: number }>())
      .toMatchObject({ incomeMinor: 0, expenseMinor: 25_000 });
    const expenseReport = await app.inject({
      method: "GET",
      url: `/api/v1/reports/expenses?from=${today}&to=${today}`,
      headers: authorization,
    });
    expect(expenseReport.json<{ items: Array<{ amount_minor: number }> }>().items)
      .toContainEqual(expect.objectContaining({ amount_minor: 25_000 }));
    const categoryReport = await app.inject({
      method: "GET",
      url: `/api/v1/reports/categories?from=${today}&to=${today}`,
      headers: authorization,
    });
    expect(categoryReport.json<{ items: Array<{ category_name: string; amount_minor: number; currency: string }> }>().items)
      .toContainEqual(expect.objectContaining({ category_name: "Groceries", amount_minor: 25_000, currency: "INR" }));
    const cashFlowReport = await app.inject({
      method: "GET",
      url: `/api/v1/reports/cash-flow?from=${today}&to=${today}`,
      headers: authorization,
    });
    expect(cashFlowReport.json<{ items: Array<{ expense_minor: number; net_minor: number; currency: string }> }>().items)
      .toContainEqual(expect.objectContaining({ expense_minor: 25_000, net_minor: -25_000, currency: "INR" }));
    const invalidReportRange = await app.inject({
      method: "GET",
      url: `/api/v1/reports/income?from=${today}&to=2020-01-01`,
      headers: authorization,
    });
    expect(invalidReportRange.statusCode).toBe(400);

    const budgetList = await app.inject({
      method: "GET",
      url: "/api/v1/budgets",
      headers: authorization,
    });
    const listedBudgets = budgetList.json<{ items: Array<{ id: string; spent_minor: number; category_names?: string }> }>().items;
    expect(listedBudgets.find((budget) => budget.id === overallBudget.id)?.spent_minor).toBe(25_000);
    expect(listedBudgets.find((budget) => budget.id === categoryBudget.id))
      .toMatchObject({ spent_minor: 25_000, category_names: "Groceries" });

    const importPayload = {
      accountId: account.id,
      fileName: "statement.csv",
      fileType: "csv",
      fileHash: randomUUID(),
      rows: [
        {
          rowNumber: 2,
          description: "Imported lunch",
          transactionDate: today.split("-").reverse().join("-"),
          debitMinor: 1_000,
          creditMinor: 0,
          balanceMinor: 87_500,
          externalReference: `ref-${randomUUID()}`,
        },
        {
          rowNumber: 3,
          description: "Invalid date transaction",
          transactionDate: "31-02-2026",
          debitMinor: 2_000,
          creditMinor: 0,
          balanceMinor: 85_500,
        },
      ],
    };
    const importResponse = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: authorization,
      payload: importPayload,
    });
    expect(importResponse.statusCode).toBe(201);
    const imported = importResponse.json<{ id: string }>();
    const duplicateImport = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: authorization,
      payload: importPayload,
    });
    expect(duplicateImport.statusCode).toBe(200);
    expect(duplicateImport.json<{ id: string; duplicate: boolean }>())
      .toMatchObject({ id: imported.id, duplicate: true });

    const importList = await app.inject({
      method: "GET",
      url: "/api/v1/imports",
      headers: authorization,
    });
    const batch = importList.json<{ items: Array<{ id: string; status: string; total_rows: number }> }>().items[0];
    expect(batch).toMatchObject({ id: imported.id, status: "draft", total_rows: 2 });

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/imports/${imported.id}/preview`,
      headers: authorization,
    });
    const previewData = preview.json<{
      rows: Array<{ id: string; validation_status: string; balance_minor: number | null }>;
      reconciliation: { status: string; openingBalanceMinor: number; reportedClosingBalanceMinor: number };
    }>();
    expect(previewData.reconciliation).toMatchObject({
      status: "matched",
      openingBalanceMinor: 88_500,
      reportedClosingBalanceMinor: 85_500,
    });
    expect(previewData.rows[0].balance_minor).toBe(87_500);
    const rows = previewData.rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const approval = await app.inject({
        method: "POST",
        url: `/api/v1/imports/${imported.id}/rows/${row.id}/approve`,
        headers: authorization,
      });
      expect(approval.statusCode).toBe(200);
    }

    const confirmation = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${imported.id}/confirm`,
      headers: authorization,
    });
    expect(confirmation.json<{ status: string; acceptedRows: number; rejectedRows?: number }>()).toMatchObject({
      status: "completed",
      acceptedRows: 1,
    });

    const completedImports = await app.inject({
      method: "GET",
      url: "/api/v1/imports",
      headers: authorization,
    });
    expect(completedImports.json<{ items: Array<{ id: string; rejected_rows: number }> }>().items[0])
      .toMatchObject({ id: imported.id, rejected_rows: 1 });

    const transactions = await app.inject({
      method: "GET",
      url: "/api/v1/transactions",
      headers: authorization,
    });
    expect(transactions.json<{ items: Array<{ description: string; transaction_at: string }> }>().items)
      .toContainEqual(expect.objectContaining({
        description: "Imported lunch",
        transaction_at: expect.stringMatching(new RegExp(`^${today}`)),
      }));

    const refreshedBudgets = await app.inject({
      method: "GET",
      url: "/api/v1/budgets",
      headers: authorization,
    });
    const refreshedItems = refreshedBudgets.json<{ items: Array<{ id: string; spent_minor: number }> }>().items;
    expect(refreshedItems.find((budget) => budget.id === overallBudget.id)?.spent_minor).toBe(26_000);
    expect(refreshedItems.find((budget) => budget.id === categoryBudget.id)?.spent_minor).toBe(25_000);

    const categoryPerformance = await app.inject({
      method: "GET",
      url: `/api/v1/budgets/${categoryBudget.id}/performance`,
      headers: authorization,
    });
    expect(categoryPerformance.json<{
      spentMinor: number;
      categoryAllocations: Array<{ categoryName: string; limitMinor: number; spentMinor: number; remainingMinor: number }>;
    }>()).toMatchObject({
      spentMinor: 25_000,
      categoryAllocations: [{
        categoryName: "Groceries",
        limitMinor: 20_000,
        spentMinor: 25_000,
        remainingMinor: -5_000,
      }],
    });

    const expenseTransactionId = responses.find((response) => response.statusCode === 201)!.json<{ id: string }>().id;
    const metadataEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${expenseTransactionId}`,
      headers: authorization,
      payload: { description: "Groceries updated" },
    });
    expect(metadataEdit.statusCode).toBe(200);
    const attemptedAmountEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${expenseTransactionId}`,
      headers: authorization,
      payload: { amountMinor: 1 },
    });
    expect(attemptedAmountEdit.statusCode).toBe(400);
    const transactionAudit = await app.inject({
      method: "GET",
      url: `/api/v1/transactions/${expenseTransactionId}/audit`,
      headers: authorization,
    });
    expect(transactionAudit.json<{ items: Array<{ action: string; before_data: string; after_data: string }> }>().items)
      .toContainEqual(expect.objectContaining({
        action: "metadata_updated",
        before_data: expect.stringContaining("Groceries"),
        after_data: expect.stringContaining("Groceries updated"),
      }));
    await app.inject({
      method: "PATCH",
      url: `/api/v1/transactions/${expenseTransactionId}`,
      headers: authorization,
      payload: { description: "=1+1" },
    });
    const exportResponse = await app.inject({
      method: "GET",
      url: `/api/v1/exports/transactions.csv?accountId=${account.id}`,
      headers: authorization,
    });
    expect(exportResponse.headers["content-type"]).toContain("text/csv");
    expect(exportResponse.body).toContain(`"'=1+1"`);

    const reversal = await app.inject({
      method: "POST",
      url: `/api/v1/transactions/${expenseTransactionId}/reverse`,
      headers: authorization,
    });
    expect(reversal.statusCode).toBe(201);
    const duplicateReversal = await app.inject({
      method: "POST",
      url: `/api/v1/transactions/${expenseTransactionId}/reverse`,
      headers: authorization,
    });
    expect(duplicateReversal.statusCode).toBe(400);

    const reversedTransactions = await app.inject({
      method: "GET",
      url: `/api/v1/transactions?status=reversed`,
      headers: authorization,
    });
    expect(reversedTransactions.json<{ items: Array<{ id: string; status: string }> }>().items)
      .toContainEqual(expect.objectContaining({ id: expenseTransactionId, status: "reversed" }));
    const balanceAfterReversal = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${account.id}/balance`,
      headers: authorization,
    });
    expect(balanceAfterReversal.json<{ balanceMinor: number }>().balanceMinor).toBe(3_499_000);
    const budgetArchive = await app.inject({
      method: "POST",
      url: `/api/v1/budgets/${categoryBudget.id}/archive`,
      headers: authorization,
    });
    expect(budgetArchive.statusCode).toBe(200);
    const activeBudgets = await app.inject({
      method: "GET",
      url: "/api/v1/budgets",
      headers: authorization,
    });
    expect(activeBudgets.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id))
      .not.toContain(categoryBudget.id);
    const loanAccountResponse = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: authorization,
      payload: {
        name: "Test loan liability",
        accountType: "loan",
        currency: "INR",
        openingBalanceMinor: 500_000,
      },
    });
    const loanAccount = loanAccountResponse.json<{ id: string }>();
    const loanResponse = await app.inject({
      method: "POST",
      url: "/api/v1/loans",
      headers: authorization,
      payload: {
        accountId: loanAccount.id,
        lenderName: "Test lender",
        loanType: "personal",
        originalPrincipalMinor: 500_000,
        interestRate: "12",
        startDate: today,
        tenureMonths: 2,
      },
    });
    expect(loanResponse.statusCode).toBe(201);
    const loan = loanResponse.json<{ id: string }>();
    const schedule = await app.inject({
      method: "POST",
      url: `/api/v1/loans/${loan.id}/schedule`,
      headers: authorization,
      payload: { principalMinor: 500_000, annualInterestPercent: 12, tenureMonths: 2 },
    });
    expect(schedule.statusCode).toBe(200);
    const duplicateSchedule = await app.inject({
      method: "POST",
      url: `/api/v1/loans/${loan.id}/schedule`,
      headers: authorization,
      payload: { principalMinor: 500_000, annualInterestPercent: 12, tenureMonths: 2 },
    });
    expect(duplicateSchedule.statusCode).toBe(400);
    const installmentSchedule = await app.inject({
      method: "GET",
      url: `/api/v1/loans/${loan.id}/schedule`,
      headers: authorization,
    });
    const installments = installmentSchedule.json<{ items: Array<{
      id: string;
      scheduled_principal_minor: number;
      scheduled_interest_minor: number;
      scheduled_fees_minor: number;
      status: string;
    }> }>().items;
    expect(installments).toHaveLength(2);
    const firstInstallment = installments[0];
    const payment = await app.inject({
      method: "POST",
      url: `/api/v1/installments/${firstInstallment.id}/payment`,
      headers: authorization,
      payload: {
        paymentAccountId: account.id,
        principalMinor: firstInstallment.scheduled_principal_minor,
        interestMinor: firstInstallment.scheduled_interest_minor,
        feesMinor: firstInstallment.scheduled_fees_minor,
        idempotencyKey: `emi-${randomUUID()}`,
      },
    });
    expect(payment.statusCode).toBe(201);
    const loanBalance = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${loanAccount.id}/balance`,
      headers: authorization,
    });
    expect(loanBalance.json<{ balanceMinor: number }>().balanceMinor)
      .toBe(500_000 - firstInstallment.scheduled_principal_minor);
    const recurringArchive = await app.inject({
      method: "POST",
      url: `/api/v1/recurring-rules/${recurringRule.id}/archive`,
      headers: authorization,
    });
    expect(recurringArchive.statusCode).toBe(200);
    const activeRecurringRules = await app.inject({
      method: "GET",
      url: "/api/v1/recurring-rules",
      headers: authorization,
    });
    expect(activeRecurringRules.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id))
      .not.toContain(recurringRule.id);

    const cardAccountResponse = await app.inject({
      method: "POST",
      url: "/api/v1/accounts",
      headers: authorization,
      payload: { name: "Test credit card", accountType: "credit_card", currency: "INR" },
    });
    const cardAccount = cardAccountResponse.json<{ id: string }>();
    const cardResponse = await app.inject({
      method: "POST",
      url: "/api/v1/credit-cards",
      headers: authorization,
      payload: {
        accountId: cardAccount.id,
        cardName: "Test card",
        creditLimitMinor: 100_000,
        linkedPaymentAccountId: account.id,
      },
    });
    expect(cardResponse.statusCode).toBe(201);
    const card = cardResponse.json<{ id: string }>();
    const cardPurchase = await app.inject({
      method: "POST",
      url: "/api/v1/transactions",
      headers: authorization,
      payload: {
        transactionType: "expense",
        amountMinor: 20_000,
        currency: "INR",
        accountId: cardAccount.id,
        categoryId: category.id,
        description: "Card purchase",
        idempotencyKey: `card-purchase-${randomUUID()}`,
      },
    });
    expect(cardPurchase.statusCode).toBe(201);
    const cardPayment = await app.inject({
      method: "POST",
      url: `/api/v1/credit-cards/${card.id}/payment`,
      headers: authorization,
      payload: {
        paymentAccountId: account.id,
        amountMinor: 5_000,
        paymentAt: new Date().toISOString(),
        idempotencyKey: `card-payment-${randomUUID()}`,
      },
    });
    expect(cardPayment.statusCode).toBe(201);
    const cardList = await app.inject({
      method: "GET",
      url: "/api/v1/credit-cards",
      headers: authorization,
    });
    expect(cardList.json<{ items: Array<{ id: string; outstanding_minor: number; available_limit_minor: number }> }>().items)
      .toContainEqual(expect.objectContaining({
        id: card.id,
        outstanding_minor: 15_000,
        available_limit_minor: 85_000,
      }));
    const cardStatement = await app.inject({
      method: "GET",
      url: `/api/v1/credit-cards/${card.id}/statement?from=${today}&to=${today}`,
      headers: authorization,
    });
    expect(cardStatement.statusCode).toBe(200);
    expect(cardStatement.json<{
      openingBalanceMinor: number;
      closingBalanceMinor: number;
      items: Array<{ description: string; amount_minor: number }>;
    }>()).toMatchObject({
      openingBalanceMinor: 0,
      closingBalanceMinor: 15_000,
      items: expect.arrayContaining([
        expect.objectContaining({ description: "Card purchase", amount_minor: 20_000 }),
        expect.objectContaining({ description: "Credit card bill payment", amount_minor: -5_000 }),
      ]),
    });
    const invalidCardStatement = await app.inject({
      method: "GET",
      url: `/api/v1/credit-cards/${card.id}/statement?from=${today}&to=2020-01-01`,
      headers: authorization,
    });
    expect(invalidCardStatement.statusCode).toBe(400);

    const syncKey = `offline-${randomUUID()}`;
    const syncOperation = {
      deviceId: "test-device",
      operationType: "transaction",
      idempotencyKey: syncKey,
      payload: {
        transactionType: "expense",
        amountMinor: 700,
        currency: "INR",
        accountId: account.id,
        description: "Synced offline expense",
        idempotencyKey: syncKey,
      },
    };
    const synced = await app.inject({
      method: "POST",
      url: "/api/v1/sync/operations",
      headers: authorization,
      payload: syncOperation,
    });
    expect(synced.statusCode).toBe(201);
    expect(synced.json<{ status: string }>().status).toBe("completed");
    const repeatedSync = await app.inject({
      method: "POST",
      url: "/api/v1/sync/operations",
      headers: authorization,
      payload: syncOperation,
    });
    expect(repeatedSync.statusCode).toBe(200);
    expect(repeatedSync.json<{ status: string }>().status).toBe("duplicate");
    const conflictingSync = await app.inject({
      method: "POST",
      url: "/api/v1/sync/operations",
      headers: authorization,
      payload: {
        ...syncOperation,
        payload: { ...syncOperation.payload, amountMinor: 701 },
      },
    });
    expect(conflictingSync.statusCode).toBe(409);

    const candidateId = randomUUID();
    const notificationKey = `notification-${randomUUID()}`;
    const notificationPayload = {
      candidateId,
      deviceId: "test-device",
      sourcePackage: "com.phonepe.app",
      receivedAt: new Date().toISOString(),
      amountMinor: 2_500,
      currency: "INR",
      direction: "expense",
      description: "Notification grocery payment",
      referenceHash: "a".repeat(64),
      accountId: account.id,
      categoryId: category.id,
      idempotencyKey: notificationKey,
    };
    const notificationSync = await app.inject({
      method: "POST",
      url: "/api/v1/sync/operations",
      headers: authorization,
      payload: {
        deviceId: "test-device",
        operationType: "notification_confirmation",
        idempotencyKey: notificationKey,
        payload: notificationPayload,
      },
    });
    expect(notificationSync.statusCode).toBe(201);
    const notificationEvent = await db.execute({
      sql: `SELECT processing_status,extracted_description FROM notification_events
            WHERE user_id=? AND candidate_fingerprint IS NOT NULL`,
      args: [registration.json<{ user: { id: string } }>().user.id],
    });
    expect(notificationEvent.rows).toContainEqual(expect.objectContaining({
      processing_status: "posted",
      extracted_description: "Notification grocery payment",
    }));
    const repeatedNotificationKey = `notification-${randomUUID()}`;
    const repeatedNotification = await app.inject({
      method: "POST",
      url: "/api/v1/sync/operations",
      headers: authorization,
      payload: {
        deviceId: "test-device",
        operationType: "notification_confirmation",
        idempotencyKey: repeatedNotificationKey,
        payload: { ...notificationPayload, idempotencyKey: repeatedNotificationKey },
      },
    });
    expect(repeatedNotification.statusCode).toBe(200);
    const notificationTransactions = await db.execute({
      sql: `SELECT COUNT(*) AS count FROM transactions WHERE user_id=? AND idempotency_key=?`,
      args: [registration.json<{ user: { id: string } }>().user.id,`notification:${candidateId}`],
    });
    expect(Number(notificationTransactions.rows[0]?.count)).toBe(1);
  });
});
