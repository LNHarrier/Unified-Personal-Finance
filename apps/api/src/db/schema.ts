import type { Client } from "@libsql/client";

export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    default_currency TEXT NOT NULL DEFAULT 'INR',
    country TEXT,
    time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    account_type TEXT NOT NULL,
    institution_name TEXT,
    masked_account_number TEXT,
    currency TEXT NOT NULL DEFAULT 'INR',
    opening_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    category_type TEXT NOT NULL,
    parent_id TEXT REFERENCES categories(id),
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, name, category_type)
  )`,
  `CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    account_code TEXT NOT NULL,
    account_name TEXT NOT NULL,
    account_class TEXT NOT NULL,
    normal_balance TEXT NOT NULL,
    linked_financial_account_id TEXT REFERENCES accounts(id),
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    UNIQUE(user_id, account_code)
  )`,
  `CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    entry_number TEXT NOT NULL,
    description TEXT,
    effective_at TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    status TEXT NOT NULL DEFAULT 'posted',
    reversal_of_entry_id TEXT REFERENCES journal_entries(id),
    created_at TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    UNIQUE(user_id, entry_number)
  )`,
  `CREATE TABLE IF NOT EXISTS journal_lines (
    id TEXT PRIMARY KEY,
    journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
    ledger_account_id TEXT NOT NULL REFERENCES chart_of_accounts(id),
    debit_minor INTEGER NOT NULL CHECK(debit_minor >= 0),
    credit_minor INTEGER NOT NULL CHECK(credit_minor >= 0),
    currency TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    CHECK ((debit_minor > 0 AND credit_minor = 0) OR
           (credit_minor > 0 AND debit_minor = 0))
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
    transaction_type TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    currency TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    category_id TEXT REFERENCES categories(id),
    payee_id TEXT,
    description TEXT,
    transaction_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'posted',
    source_type TEXT NOT NULL,
    source_reference TEXT,
    import_batch_id TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS opening_balances (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    amount_minor INTEGER NOT NULL,
    effective_at TEXT NOT NULL,
    journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
    created_at TEXT NOT NULL,
    UNIQUE(user_id, account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    actor_id TEXT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before_data TEXT,
    after_data TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    period_type TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    total_limit_minor INTEGER NOT NULL CHECK(total_limit_minor >= 0),
    currency TEXT NOT NULL,
    rollover_policy TEXT NOT NULL DEFAULT 'none',
    alert_threshold INTEGER NOT NULL DEFAULT 90,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS budget_categories (
    id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id),
    limit_minor INTEGER NOT NULL CHECK(limit_minor > 0),
    created_at TEXT NOT NULL,
    UNIQUE(budget_id, category_id)
  )`,
  `CREATE TABLE IF NOT EXISTS loans (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    lender_name TEXT NOT NULL,
    loan_type TEXT NOT NULL,
    original_principal_minor INTEGER NOT NULL CHECK(original_principal_minor > 0),
    interest_rate TEXT NOT NULL DEFAULT '0',
    start_date TEXT NOT NULL,
    end_date TEXT,
    tenure_months INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS credit_cards (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    issuer TEXT,
    card_name TEXT NOT NULL,
    masked_card_number TEXT,
    credit_limit_minor INTEGER NOT NULL CHECK(credit_limit_minor >= 0),
    statement_day INTEGER,
    due_day INTEGER,
    linked_payment_account_id TEXT REFERENCES accounts(id),
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payees (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    display_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS installments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    loan_id TEXT NOT NULL REFERENCES loans(id),
    installment_number INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    scheduled_principal_minor INTEGER NOT NULL CHECK(scheduled_principal_minor >= 0),
    scheduled_interest_minor INTEGER NOT NULL CHECK(scheduled_interest_minor >= 0),
    scheduled_fees_minor INTEGER NOT NULL DEFAULT 0,
    scheduled_total_minor INTEGER NOT NULL CHECK(scheduled_total_minor >= 0),
    paid_total_minor INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'scheduled',
    actual_payment_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(loan_id, installment_number)
  )`,
  `CREATE TABLE IF NOT EXISTS recurring_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    transaction_type TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    currency TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    category_id TEXT REFERENCES categories(id),
    payee_id TEXT REFERENCES payees(id),
    frequency TEXT NOT NULL,
    interval_value INTEGER NOT NULL DEFAULT 1,
    start_date TEXT NOT NULL,
    end_date TEXT,
    next_occurrence TEXT NOT NULL,
    auto_post_policy TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    total_rows INTEGER NOT NULL DEFAULT 0,
    accepted_rows INTEGER NOT NULL DEFAULT 0,
    duplicate_rows INTEGER NOT NULL DEFAULT 0,
    rejected_rows INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS import_rows (
    id TEXT PRIMARY KEY,
    import_batch_id TEXT NOT NULL REFERENCES import_batches(id),
    row_number INTEGER NOT NULL,
    raw_description TEXT,
    normalized_description TEXT,
    transaction_date TEXT,
    debit_minor INTEGER NOT NULL DEFAULT 0,
    credit_minor INTEGER NOT NULL DEFAULT 0,
    balance_minor INTEGER,
    external_reference TEXT,
    parsed_data TEXT,
    validation_status TEXT NOT NULL DEFAULT 'pending',
    duplicate_status TEXT NOT NULL DEFAULT 'not_checked',
    linked_transaction_id TEXT REFERENCES transactions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS external_transaction_refs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    source TEXT NOT NULL,
    external_reference TEXT NOT NULL,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    created_at TEXT NOT NULL,
    UNIQUE(account_id, source, external_reference)
  )`,
  `CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT,
    source_package TEXT,
    received_at TEXT NOT NULL,
    extracted_amount_minor INTEGER,
    extracted_currency TEXT,
    extracted_direction TEXT,
    extracted_description TEXT,
    extracted_reference TEXT,
    candidate_fingerprint TEXT,
    extracted_status TEXT,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    processing_started_at TEXT,
    linked_transaction_id TEXT REFERENCES transactions(id),
    retention_expiry TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sync_operations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT,
    idempotency_key TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    request_hash TEXT,
    response_reference TEXT,
    status TEXT NOT NULL DEFAULT 'accepted',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(user_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS app_config (
    id TEXT PRIMARY KEY,
    config_key TEXT NOT NULL,
    config_value TEXT NOT NULL,
    environment TEXT NOT NULL,
    version TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, transaction_at)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id)`,
];

export async function applySchema(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON");
  const transaction = await client.transaction("write");
  try {
    await transaction.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    );
    const result = await transaction.execute(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    const currentVersion = Number(result.rows[0]?.version ?? 0);
    if (currentVersion > 1) {
      throw new Error(`Database schema version ${currentVersion} is newer than this API supports.`);
    }

    if (currentVersion < 1) {
      for (const statement of schemaStatements) await transaction.execute(statement);
      const budgetCategoryColumns = await transaction.execute("PRAGMA table_info(budget_categories)");
      if (!budgetCategoryColumns.rows.some((column) => column.name === "limit_minor")) {
        await transaction.execute(
          "ALTER TABLE budget_categories ADD COLUMN limit_minor INTEGER NOT NULL DEFAULT 0 CHECK(limit_minor >= 0)",
        );
      }
      await transaction.execute(
        `UPDATE budget_categories
         SET limit_minor=(SELECT total_limit_minor FROM budgets WHERE budgets.id=budget_categories.budget_id)
         WHERE limit_minor=0`,
      );
      const notificationColumns = await transaction.execute("PRAGMA table_info(notification_events)");
      const notificationColumnNames = new Set(notificationColumns.rows.map((column) => String(column.name)));
      for (const [name, type] of [
        ["extracted_currency", "TEXT"],
        ["extracted_direction", "TEXT"],
        ["extracted_description", "TEXT"],
        ["candidate_fingerprint", "TEXT"],
        ["processing_started_at", "TEXT"],
      ] as const) {
        if (!notificationColumnNames.has(name)) {
          await transaction.execute(`ALTER TABLE notification_events ADD COLUMN ${name} ${type}`);
        }
      }
      await transaction.execute(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_candidate_fingerprint
         ON notification_events(user_id,candidate_fingerprint) WHERE candidate_fingerprint IS NOT NULL`,
      );
      await transaction.execute({
        sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        args: [1, new Date().toISOString()],
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}
