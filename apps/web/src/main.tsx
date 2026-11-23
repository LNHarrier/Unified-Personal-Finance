import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, downloadCsv, getToken, setToken } from "./api.js";
import "./styles.css";

type Account = { id: string; name: string; account_type: string; currency: string; status: string };
type Transaction = { id: string; transaction_type: string; amount_minor: number; currency: string; account_name: string; category_id?: string | null; category_name?: string; payee_name?: string; description?: string | null; transaction_at: string; status: string; source_type: string };
type TransactionFilters = { search: string; transactionType: string; accountId: string; from: string; to: string; sort: string };
type Budget = { id: string; name: string; period_type: string; start_date: string; end_date: string; total_limit_minor: number; spent_minor: number; currency: string; category_names?: string };
type BudgetAllocation = { categoryId: string; limitMinor: number };
type BudgetCategoryPerformance = { categoryId: string; categoryName: string; limitMinor: number; spentMinor: number; remainingMinor: number; utilizationPercent: number };
type BudgetPerformance = { categoryAllocations: BudgetCategoryPerformance[] };
type Loan = { id: string; account_id: string; lender_name: string; loan_type: string; original_principal_minor: number; interest_rate: string; start_date: string; tenure_months: number | null };
type Card = { id: string; account_id: string; card_name: string; issuer?: string; currency: string; credit_limit_minor: number; outstanding_minor: number; available_limit_minor: number; linked_payment_account_id?: string | null };
type CardStatement = { from: string; to: string; currency: string; openingBalanceMinor: number; closingBalanceMinor: number; items: Array<{ journal_entry_id: string; effective_at: string; description: string; amount_minor: number }> };
type RecurringRule = { id: string; transaction_type: "income" | "expense"; amount_minor: number; currency: string; account_id: string; frequency: string; interval_value: number; start_date: string; end_date?: string | null; next_occurrence: string; auto_post_policy: string };
type Installment = { id: string; loan_id: string; installment_number: number; due_date: string; scheduled_principal_minor: number; scheduled_interest_minor: number; scheduled_fees_minor: number; scheduled_total_minor: number; paid_total_minor: number; status: string };
type Category = { id: string; name: string; category_type: "income" | "expense" };
type CategorySpending = { category_id: string | null; category_name: string; currency: string; amount_minor: number; transaction_count: number };
type CashFlowRow = { date: string; currency: string; income_minor: number; expense_minor: number; net_minor: number };
type ImportBatch = { id: string; file_name: string; status: string; total_rows: number; accepted_rows: number; duplicate_rows: number; rejected_rows: number; created_at: string; account_currency?: string };
type ImportRow = { id: string; row_number: number; raw_description?: string; transaction_date?: string; debit_minor: number; credit_minor: number; balance_minor?: number | null; validation_status: string; duplicate_status: string; linked_transaction_id?: string };
type ImportReconciliation = {
  status: "not_provided" | "matched" | "discrepancy" | "incomplete";
  openingBalanceMinor: number | null;
  calculatedClosingBalanceMinor: number | null;
  reportedClosingBalanceMinor: number | null;
  checkedRows: number;
  missingBalanceRows: number[];
  invalidBalanceRows: number[];
  invalidRows: number[];
  discrepancies: Array<{ rowNumber: number; expectedBalanceMinor: number; reportedBalanceMinor: number; differenceMinor: number }>;
};

function money(minor: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);
}

function transactionQuery(filters: TransactionFilters, endpoint = "/transactions") {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.transactionType) params.set("transactionType", filters.transactionType);
  if (filters.accountId) params.set("accountId", filters.accountId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.sort) params.set("sort", filters.sort);
  const query = params.toString();
  return `/api/v1${endpoint}${query ? `?${query}` : ""}`;
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const path = mode === "login" ? "/api/v1/auth/login" : "/api/v1/auth/register";
      const body = mode === "login"
        ? { email, password }
        : { email, password, displayName };
      const result = await api<{ token: string }>(path, { method: "POST", body: JSON.stringify(body) });
      setToken(result.token);
      onLogin(result.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    }
  };
  return (
    <main className="auth">
      <section className="auth-brand">
        <div className="mark">F</div>
        <h1>Finova</h1>
        <p>Your complete financial life, in one place.</p>
      </section>
      <form className="card auth-card" onSubmit={submit}>
        <p className="eyebrow">UNIFIED PERSONAL FINANCE</p>
        <h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
        {mode === "register" && <label>Display name<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></label>}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">{mode === "login" ? "Sign in" : "Create account"}</button>
        <button className="text" type="button" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "New here? Create account" : "Already registered? Sign in"}
        </button>
      </form>
    </main>
  );
}

function App() {
  const [token, setAuthToken] = useState(getToken());
  const [page, setPage] = useState("Dashboard");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transactionError, setTransactionError] = useState("");
  const [exportError, setExportError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [transactionFilters, setTransactionFilters] = useState<TransactionFilters>({
    search: "",
    transactionType: "",
    accountId: "",
    from: "",
    to: "",
    sort: "newest",
  });
  const [activeTransactionFilters, setActiveTransactionFilters] = useState<TransactionFilters>({
    search: "",
    transactionType: "",
    accountId: "",
    from: "",
    to: "",
    sort: "newest",
  });
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [activeLoanScheduleId, setActiveLoanScheduleId] = useState("");
  const [paymentInstallment, setPaymentInstallment] = useState<Installment | null>(null);
  const [loanError, setLoanError] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [cardError, setCardError] = useState("");
  const [cardAction, setCardAction] = useState<{ card: Card; mode: "purchase" | "payment" } | null>(null);
  const [selectedCardStatement, setSelectedCardStatement] = useState<{ cardId: string; statement: CardStatement } | null>(null);
  const [statementLoadingId, setStatementLoadingId] = useState("");
  const [recurringRules, setRecurringRules] = useState<RecurringRule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [selectedImport, setSelectedImport] = useState<{ batch: ImportBatch; rows: ImportRow[]; reconciliation: ImportReconciliation } | null>(null);
  const [acknowledgeReconciliation, setAcknowledgeReconciliation] = useState(false);
  const [importAccountId, setImportAccountId] = useState("");
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState({ incomeMinor: 0, expenseMinor: 0, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 });
  const [reportSummary, setReportSummary] = useState({ incomeMinor: 0, expenseMinor: 0, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 });
  const [reportFilters, setReportFilters] = useState({ from: "", to: "" });
  const [reportError, setReportError] = useState("");
  const [categorySpending, setCategorySpending] = useState<CategorySpending[]>([]);
  const [cashFlow, setCashFlow] = useState<CashFlowRow[]>([]);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [modal, setModal] = useState<"account" | "transaction" | "transfer" | "budget" | "loan" | "card" | "recurring" | null>(null);

  const loadTransactions = async (filters: TransactionFilters = activeTransactionFilters) => {
    try {
      const data = await api<{ items: Transaction[] }>(transactionQuery(filters));
      setTransactions(data.items);
      setTransactionError("");
    } catch (cause) {
      setTransactionError(cause instanceof Error ? cause.message : "Could not load transactions.");
    }
  };

  const refresh = async () => {
    const [accountData, summaryData, budgetData, loanData, cardData, recurringData, installmentData, categoryData, importData] = await Promise.all([
      api<{ items: Account[] }>("/api/v1/accounts"),
      api<typeof summary>("/api/v1/reports/summary"),
      api<{ items: Budget[] }>("/api/v1/budgets"),
      api<{ items: Loan[] }>("/api/v1/loans"),
      api<{ items: Card[] }>("/api/v1/credit-cards"),
      api<{ items: RecurringRule[] }>("/api/v1/recurring-rules"),
      api<{ items: Installment[] }>("/api/v1/installments"),
      api<{ items: Category[] }>("/api/v1/categories"),
      api<{ items: ImportBatch[] }>("/api/v1/imports"),
    ]);
    setAccounts(accountData.items);
    setSummary(summaryData);
    setReportSummary(summaryData);
    setBudgets(budgetData.items);
    setLoans(loanData.items);
    setCards(cardData.items);
    setRecurringRules(recurringData.items);
    setInstallments(installmentData.items);
    setCategories(categoryData.items);
    setImports(importData.items);
    setCardError("");
    setImportAccountId((current) => current || accountData.items[0]?.id || "");
    setLoadError("");
    await loadTransactions();
  };

  useEffect(() => {
    if (token) refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Could not load account data."));
  }, [token]);

  useEffect(() => {
    if (!token || page !== "Reports") return;
    const params = new URLSearchParams();
    if (reportFilters.from) params.set("from", reportFilters.from);
    if (reportFilters.to) params.set("to", reportFilters.to);
    const queryString = params.toString();
    const reportQuery = queryString ? `?${queryString}` : "";
    Promise.all([
      api<typeof reportSummary>(`/api/v1/reports/summary${reportQuery}`),
      api<{ items: CategorySpending[] }>(`/api/v1/reports/categories${reportQuery}`),
      api<{ items: CashFlowRow[] }>(`/api/v1/reports/cash-flow${reportQuery}`),
    ])
      .then(([summaryData, categoryData, cashFlowData]) => {
        setReportSummary(summaryData);
        setCategorySpending(categoryData.items);
        setCashFlow(cashFlowData.items);
        setReportError("");
      })
      .catch((cause) => setReportError(cause instanceof Error ? cause.message : "Could not load filtered report."));
  }, [token, page, reportFilters.from, reportFilters.to]);

  if (!token) return <Login onLogin={(nextToken) => setAuthToken(nextToken)} />;

  const logout = () => {
    api("/api/v1/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    setToken(null);
    setAuthToken(null);
  };
  const uploadStatement = async (file?: File) => {
    if (!file) return;
    setImportError("");
    setImporting(true);
    try {
      if (!importAccountId) throw new Error("Create or select an account before importing.");
      if (file.size > 10 * 1024 * 1024) throw new Error("Statement files must be 10 MB or smaller.");
      const { parseStatementFile } = await import("./statementParser.js");
      const { fileType, rows } = await parseStatementFile(file);
      if (rows.length > 2000) throw new Error("A statement import can contain at most 2,000 transaction rows.");
      const hashBuffer = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const fileHash = Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
      await api("/api/v1/imports", {
        method: "POST",
        body: JSON.stringify({
          accountId: importAccountId,
          fileName: file.name,
          fileType,
          fileHash,
          rows,
        }),
      });
      await refresh();
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  };
  const reviewImport = async (id: string) => {
    try {
      const preview = await api<{ batch: ImportBatch; rows: ImportRow[]; reconciliation: ImportReconciliation }>(`/api/v1/imports/${id}/preview`);
      setSelectedImport(preview);
      setAcknowledgeReconciliation(false);
      setImportError("");
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Unable to preview import.");
    }
  };
  const approveAndConfirm = async () => {
    if (!selectedImport) return;
    setImportError("");
    try {
      for (const row of selectedImport.rows) {
        if (row.validation_status !== "approved") {
          await api(`/api/v1/imports/${selectedImport.batch.id}/rows/${row.id}/approve`, { method: "POST", body: "{}" });
        }
      }
      await api(`/api/v1/imports/${selectedImport.batch.id}/confirm`, { method: "POST", body: "{}" });
      setSelectedImport(null);
      setAcknowledgeReconciliation(false);
      await refresh();
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not confirm import.");
    }
  };
  const cancelImport = async () => {
    if (!selectedImport) return;
    setImportError("");
    try {
      await api(`/api/v1/imports/${selectedImport.batch.id}/cancel`, { method: "POST", body: "{}" });
      setSelectedImport(null);
      setAcknowledgeReconciliation(false);
      await refresh();
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not cancel import.");
    }
  };
  const applyTransactionFilters = (event: React.FormEvent) => {
    event.preventDefault();
    const next = { ...transactionFilters };
    setActiveTransactionFilters(next);
    void loadTransactions(next);
  };
  const clearTransactionFilters = () => {
    const empty: TransactionFilters = {
      search: "",
      transactionType: "",
      accountId: "",
      from: "",
      to: "",
      sort: "newest",
    };
    setTransactionFilters(empty);
    setActiveTransactionFilters(empty);
    void loadTransactions(empty);
  };
  const reverseTransaction = async (id: string) => {
    if (!window.confirm("Reverse this posted transaction? A reversal will preserve the original ledger entry.")) return;
    setTransactionError("");
    try {
      await api(`/api/v1/transactions/${id}/reverse`, { method: "POST", body: "{}" });
      await refresh();
    } catch (cause) {
      setTransactionError(cause instanceof Error ? cause.message : "Could not reverse transaction.");
    }
  };
  const exportTransactions = async () => {
    setExportError("");
    try {
      await downloadCsv(transactionQuery(activeTransactionFilters, "/exports/transactions.csv"), "transactions.csv");
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not export transactions.");
    }
  };
  const archiveBudget = async (id: string) => {
    if (!window.confirm("Archive this budget? Its history will be preserved, but it will no longer appear in active budgets.")) return;
    try {
      await api(`/api/v1/budgets/${id}/archive`, { method: "POST", body: "{}" });
      await refresh();
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Could not archive budget.");
    }
  };
  const archiveRecurringRule = async (id: string) => {
    if (!window.confirm("Archive this recurring rule? No further occurrences will be scheduled.")) return;
    try {
      await api(`/api/v1/recurring-rules/${id}/archive`, { method: "POST", body: "{}" });
      await refresh();
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Could not archive recurring rule.");
    }
  };
  const generateLoanSchedule = async (loan: Loan) => {
    setLoanError("");
    if (!window.confirm("Generate an estimated repayment schedule? This will not post payments.")) return;
    try {
      await api(`/api/v1/loans/${loan.id}/schedule`, {
        method: "POST",
        body: JSON.stringify({
          principalMinor: loan.original_principal_minor,
          annualInterestPercent: Number(loan.interest_rate),
          tenureMonths: loan.tenure_months ?? 12,
        }),
      });
      setActiveLoanScheduleId(loan.id);
      await refresh();
    } catch (cause) {
      setLoanError(cause instanceof Error ? cause.message : "Could not generate the repayment schedule.");
    }
  };
  const recordInstallmentPayment = async () => {
    setPaymentInstallment(null);
    setLoanError("");
    await refresh().catch((cause) => setLoanError(cause instanceof Error ? cause.message : "Could not refresh loan data."));
  };
  const loadCardStatement = async (card: Card) => {
    setCardError("");
    setStatementLoadingId(card.id);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const from = `${today.slice(0, 7)}-01`;
      const statement = await api<CardStatement>(`/api/v1/credit-cards/${card.id}/statement?from=${from}&to=${today}`);
      setSelectedCardStatement({ cardId: card.id, statement });
    } catch (cause) {
      setCardError(cause instanceof Error ? cause.message : "Could not load card statement.");
    } finally {
      setStatementLoadingId("");
    }
  };
  const navigation = ["Dashboard", "Accounts", "Transactions", "Budgets", "Recurring", "Loans", "Cards", "Imports", "Reports"];
  const displayedSummary = page === "Reports" ? reportSummary : summary;
  const paymentLoan = paymentInstallment ? loans.find((loan) => loan.id === paymentInstallment.loan_id) : undefined;
  const paymentCurrency = accounts.find((account) => account.id === paymentLoan?.account_id)?.currency ?? "INR";
  const importCurrency = selectedImport?.batch.account_currency ?? "INR";
  const importRequiresAcknowledgement = selectedImport?.reconciliation.status === "discrepancy"
    || selectedImport?.reconciliation.status === "incomplete";
  const maxSpendingByCurrency = categorySpending.reduce<Record<string, number>>((totals, item) => {
    totals[item.currency] = Math.max(totals[item.currency] ?? 0, item.amount_minor);
    return totals;
  }, {});

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><div className="mark">F</div><strong>Finova</strong></div>
        <nav>
          {navigation.map((item) => <button key={item} className={page === item ? "active" : ""} onClick={() => setPage(item)}>{item}</button>)}
        </nav>
        <button className="logout" onClick={logout}>Sign out</button>
      </aside>
      <main>
        <header><div><p className="eyebrow">PERSONAL FINANCE</p><h1>{page}</h1></div>
          <div className="actions">
            {page === "Accounts" && <button className="primary" onClick={() => setModal("account")}>Add account</button>}
            {page === "Transactions" && <button className="secondary" onClick={exportTransactions}>Export CSV</button>}
            {["Dashboard", "Transactions"].includes(page) && <button className="primary" onClick={() => setModal("transaction")}>Add transaction</button>}
            {["Dashboard", "Transactions", "Accounts"].includes(page) && <button className="secondary" onClick={() => setModal("transfer")}>Transfer</button>}
            {page === "Budgets" && <button className="primary" onClick={() => setModal("budget")}>Add budget</button>}
            {page === "Recurring" && <button className="primary" onClick={() => setModal("recurring")}>Add recurring rule</button>}
            {page === "Loans" && <button className="primary" onClick={() => setModal("loan")}>Add loan</button>}
            {page === "Cards" && <button className="primary" onClick={() => setModal("card")}>Add card</button>}
            {page === "Imports" && <label className="file-button">{importing ? "Importing..." : "Import statement"}<input type="file" accept=".csv,.xls,.xlsx,.pdf,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf" disabled={importing} onChange={(event) => uploadStatement(event.target.files?.[0])} /></label>}
          </div>
        </header>
        {loadError && <p className="error" role="alert">{loadError} <button className="text" onClick={() => refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Could not reload account data."))}>Retry</button></p>}

        {(page === "Dashboard" || page === "Reports") && (
          <>
            {page === "Reports" && <>
              <form className="card report-filters" onSubmit={(event) => event.preventDefault()}>
                <label>From<input type="date" value={reportFilters.from} onChange={(event) => setReportFilters({ ...reportFilters, from: event.target.value })} /></label>
                <label>To<input type="date" value={reportFilters.to} onChange={(event) => setReportFilters({ ...reportFilters, to: event.target.value })} /></label>
                <button className="text" type="button" onClick={() => setReportFilters({ from: "", to: "" })}>Clear dates</button>
                <p className="muted">Income and expenses use the selected period. Net worth shows current balances.</p>
              </form>
              {reportError && <p className="error" role="alert">{reportError}</p>}
            </>}
            <section className="metrics">
              <article className="metric green"><span>Net worth</span><strong>{money(displayedSummary.netWorthMinor)}</strong></article>
              <article className="metric"><span>Total assets</span><strong>{money(displayedSummary.assetsMinor)}</strong></article>
              <article className="metric"><span>Liabilities</span><strong>{money(displayedSummary.liabilitiesMinor)}</strong></article>
              <article className="metric"><span>Net cash flow</span><strong>{money(displayedSummary.incomeMinor - displayedSummary.expenseMinor)}</strong></article>
            </section>
            <section className="grid">
              <article className="card">
                <h3>Income and expenses</h3>
                <div className="bars">
                  <div><span>Income</span><b>{money(displayedSummary.incomeMinor)}</b></div>
                  <div className="bar"><i style={{ width: `${Math.min(100, displayedSummary.incomeMinor / Math.max(displayedSummary.incomeMinor, displayedSummary.expenseMinor, 1) * 100)}%` }} /></div>
                  <div><span>Expenses</span><b>{money(displayedSummary.expenseMinor)}</b></div>
                  <div className="bar expense"><i style={{ width: `${Math.min(100, displayedSummary.expenseMinor / Math.max(displayedSummary.incomeMinor, displayedSummary.expenseMinor, 1) * 100)}%` }} /></div>
                </div>
              </article>
              <article className="card"><h3>Recent activity</h3>{transactions.slice(0, 5).map((item) => <div className="list-row" key={item.id}><span>{item.description ?? item.transaction_type}</span><b className={item.transaction_type === "income" ? "income" : ""}>{item.transaction_type === "expense" ? "-" : "+"}{money(item.amount_minor, item.currency)}</b></div>)}{transactions.length === 0 && <p className="muted">No transactions yet.</p>}</article>
            </section>
            {page === "Reports" && <section className="card report-categories">
              <h3>Expenses by category</h3>
              {categorySpending.map((item) => {
                const currencyTotal = Math.max(1, maxSpendingByCurrency[item.currency] ?? 0);
                const width = Math.min(100, item.amount_minor / currencyTotal * 100);
                return <div key={`${item.currency}-${item.category_id ?? "uncategorized"}`} className="category-report-row">
                  <div className="budget-values"><span>{item.category_name} <small className="muted">· {item.transaction_count}</small></span><b>{money(item.amount_minor, item.currency)}</b></div>
                  <div className="bar expense"><i style={{ width: `${width}%` }} /></div>
                </div>;
              })}
              {categorySpending.length === 0 && <p className="muted">No posted expenses in this period.</p>}
            </section>}
            {page === "Reports" && <section className="card report-cashflow">
              <h3>Daily cash flow</h3>
              <div className="table">
                <table><thead><tr><th>Date</th><th>Currency</th><th className="right">Income</th><th className="right">Expenses</th><th className="right">Net</th></tr></thead>
                  <tbody>{cashFlow.slice(0, 30).map((item) => <tr key={`${item.date}-${item.currency}`}>
                    <td>{item.date}</td>
                    <td>{item.currency}</td>
                    <td className="right">{money(item.income_minor, item.currency)}</td>
                    <td className="right">{money(item.expense_minor, item.currency)}</td>
                    <td className="right">{money(item.net_minor, item.currency)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              {cashFlow.length === 0 && <p className="muted">No posted income or expenses in this period.</p>}
            </section>}
          </>
        )}

        {page === "Accounts" && <section className="cards">{accounts.map((account) => <article className="card account-card" key={account.id}><p>{account.account_type.replace("_", " ")}</p><h3>{account.name}</h3><Balance accountId={account.id} currency={account.currency} /></article>)}{accounts.length === 0 && <article className="card"><p>No accounts yet.</p></article>}</section>}
        {page === "Transactions" && <>
          <form className="card transaction-filters" onSubmit={applyTransactionFilters}>
            <label>Search<input value={transactionFilters.search} onChange={(event) => setTransactionFilters({ ...transactionFilters, search: event.target.value })} placeholder="Description, payee, account, or amount" /></label>
            <label>Type<select value={transactionFilters.transactionType} onChange={(event) => setTransactionFilters({ ...transactionFilters, transactionType: event.target.value })}><option value="">All types</option><option value="income">Income</option><option value="expense">Expense</option><option value="transfer">Transfer</option></select></label>
            <label>Account<select value={transactionFilters.accountId} onChange={(event) => setTransactionFilters({ ...transactionFilters, accountId: event.target.value })}><option value="">All accounts</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            <label>From<input type="date" value={transactionFilters.from} onChange={(event) => setTransactionFilters({ ...transactionFilters, from: event.target.value })} /></label>
            <label>To<input type="date" value={transactionFilters.to} onChange={(event) => setTransactionFilters({ ...transactionFilters, to: event.target.value })} /></label>
            <label>Sort<select value={transactionFilters.sort} onChange={(event) => setTransactionFilters({ ...transactionFilters, sort: event.target.value })}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="highest">Highest amount</option><option value="lowest">Lowest amount</option></select></label>
            <div className="filter-actions"><button className="primary" type="submit">Apply filters</button><button className="text" type="button" onClick={clearTransactionFilters}>Clear</button></div>
          </form>
          {transactionError && <p className="error" role="alert">{transactionError}</p>}
          {exportError && <p className="error" role="alert">{exportError}</p>}
          <section className="card table">
            <table><thead><tr><th>Description</th><th>Type</th><th>Account</th><th>Category / payee</th><th>Date</th><th>Status</th><th className="right">Amount</th><th>Action</th></tr></thead>
              <tbody>{transactions.map((item) => <tr key={item.id}>
                <td>{item.description ?? "Transaction"}<small className="muted">{item.source_type.replaceAll("_", " ")}</small></td>
                <td>{item.transaction_type}</td>
                <td>{item.account_name}</td>
                <td>{item.category_name ?? item.payee_name ?? "—"}</td>
                <td>{new Date(item.transaction_at).toLocaleDateString("en-IN")}</td>
                <td>{item.status}</td>
                <td className="right"><b>{money(item.amount_minor, item.currency)}</b></td>
                <td className="row-actions">
                  {(item.status === "posted" || item.status === "pending") && <button className="text" onClick={() => setEditingTransaction(item)}>Edit details</button>}
                  {item.status === "posted" && <button className="text" onClick={() => reverseTransaction(item.id)}>Reverse</button>}
                </td>
              </tr>)}</tbody>
            </table>
            {transactions.length === 0 && <p className="muted">No transactions match these filters.</p>}
          </section>
        </>}
        {page === "Budgets" && <section className="cards">
          {budgets.map((budget) => <BudgetCard key={budget.id} budget={budget}
            onEdit={() => setEditingBudget(budget)}
            onArchive={() => archiveBudget(budget.id)} />)}
          {budgets.length === 0 && <article className="card"><p>No budgets yet.</p></article>}
        </section>}
        {page === "Recurring" && <section className="card">
          <p className="muted">Rules are reminders only. Every occurrence requires manual confirmation; no ledger entry is posted automatically.</p>
          {recurringRules.length === 0 && <p>No recurring rules yet.</p>}
          {recurringRules.map((rule) => {
            const account = accounts.find((item) => item.id === rule.account_id);
            return <div className="list-row" key={rule.id}>
              <span>{rule.transaction_type} · {money(rule.amount_minor, rule.currency)}
                <small className="muted">{rule.frequency} (every {rule.interval_value}) · next {rule.next_occurrence} · {account?.name ?? "Account"}</small>
              </span>
              <button className="text" onClick={() => archiveRecurringRule(rule.id)}>Archive</button>
            </div>;
          })}
        </section>}
        {page === "Loans" && <>
          {loanError && <p className="error" role="alert">{loanError}</p>}
          <section className="cards">
            {loans.map((loan) => {
              const loanAccount = accounts.find((account) => account.id === loan.account_id);
              const scheduleRows = installments.filter((item) => item.loan_id === loan.id);
              const scheduleVisible = activeLoanScheduleId === loan.id;
              return <article className="card account-card" key={loan.id}>
                <p>{loan.loan_type} · {loan.interest_rate}% annual</p>
                <h3>{loan.lender_name}</h3>
                <div className="budget-values"><span>Original principal</span><b>{money(loan.original_principal_minor, loanAccount?.currency)}</b></div>
                {loanAccount && <div className="budget-values"><span>Current account balance</span><Balance accountId={loan.account_id} currency={loanAccount.currency} /></div>}
                <div className="loan-actions">
                  {scheduleRows.length === 0
                    ? <button className="secondary" onClick={() => generateLoanSchedule(loan)}>Generate schedule</button>
                    : <button className="secondary" onClick={() => setActiveLoanScheduleId(scheduleVisible ? "" : loan.id)}>{scheduleVisible ? "Hide schedule" : "View schedule"}</button>}
                </div>
                {scheduleVisible && <div className="table loan-schedule">
                  <table><thead><tr><th>Due</th><th>Principal</th><th>Interest</th><th>Total</th><th>Paid</th><th>Status</th><th /></tr></thead>
                    <tbody>{scheduleRows.map((item) => <tr key={item.id}>
                      <td>{item.due_date}</td>
                      <td>{money(item.scheduled_principal_minor, loanAccount?.currency)}</td>
                      <td>{money(item.scheduled_interest_minor, loanAccount?.currency)}</td>
                      <td>{money(item.scheduled_total_minor, loanAccount?.currency)}</td>
                      <td>{money(item.paid_total_minor, loanAccount?.currency)}</td>
                      <td>{item.status}</td>
                      <td>{item.status !== "paid" && <button className="text" onClick={() => setPaymentInstallment(item)}>Record payment</button>}</td>
                    </tr>)}</tbody>
                  </table>
                </div>}
              </article>;
            })}
            {loans.length === 0 && <article className="card"><p>No loans yet.</p></article>}
          </section>
        </>}
        {page === "Cards" && <>
          {cardError && <p className="error" role="alert">{cardError}</p>}
          <section className="cards">
          {cards.map((card) => <article className="card account-card" key={card.id}>
            <p>{card.issuer ?? "Credit card"} · {card.currency}</p>
            <h3>{card.card_name}</h3>
            <div className="budget-values"><span>Outstanding</span><b>{money(card.outstanding_minor, card.currency)}</b></div>
            <div className="budget-values"><span>Available limit</span><b>{money(card.available_limit_minor, card.currency)}</b></div>
            <div className="budget-values"><span>Credit limit</span><b>{money(card.credit_limit_minor, card.currency)}</b></div>
            <div className="loan-actions">
              <button className="secondary" onClick={() => setCardAction({ card, mode: "purchase" })}>Record purchase</button>
              <button className="primary" onClick={() => setCardAction({ card, mode: "payment" })} disabled={card.outstanding_minor <= 0}>Pay bill</button>
              <button className="text" onClick={() => loadCardStatement(card)} disabled={statementLoadingId === card.id}>{statementLoadingId === card.id ? "Loading..." : "Statement this month"}</button>
            </div>
            {selectedCardStatement?.cardId === card.id && <div className="card-statement">
              <p className="muted">{selectedCardStatement.statement.from} to {selectedCardStatement.statement.to}</p>
              <div className="budget-values"><span>Opening balance</span><b>{money(selectedCardStatement.statement.openingBalanceMinor, card.currency)}</b></div>
              {selectedCardStatement.statement.items.map((entry) => <div className="list-row" key={entry.journal_entry_id}>
                <span>{entry.description}<small className="muted">{new Date(entry.effective_at).toLocaleDateString("en-IN")}</small></span>
                <b>{money(entry.amount_minor, card.currency)}</b>
              </div>)}
              <div className="budget-values"><span>Closing balance</span><b>{money(selectedCardStatement.statement.closingBalanceMinor, card.currency)}</b></div>
            </div>}
          </article>)}
          {cards.length === 0 && <article className="card"><p>No credit cards yet.</p></article>}
          </section>
        </>}
        {page === "Imports" && <section className="import-layout">
          <article className="card">
            <h3>Statement import</h3>
            <p className="muted">CSV, XLS, XLSX, and text-based PDFs are parsed in your browser. Scanned PDFs require OCR and are not supported. Parsed rows are staged for review before posting.</p>
            <label>Account<select value={importAccountId} onChange={(event) => setImportAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            {importError && <p className="error">{importError}</p>}
          </article>
          <article className="card">
            <h3>Import history</h3>
            {imports.length === 0 && <p className="muted">No statements imported.</p>}
            {imports.map((batch) => <div className="list-row" key={batch.id}>
              <span>{batch.file_name}<small className="muted">{batch.status} · {batch.total_rows} rows · {batch.accepted_rows} posted · {batch.duplicate_rows} duplicates · {batch.rejected_rows} rejected</small></span>
              <button className="text" onClick={() => reviewImport(batch.id)}>Review</button>
            </div>)}
          </article>
          {selectedImport && <article className="card table import-preview">
            <h3>Review {selectedImport.batch.file_name} <small className="muted">· {selectedImport.batch.status}</small></h3>
            {selectedImport.reconciliation.status === "not_provided" && <p className="muted">No running balances were supplied; statement balance reconciliation is unavailable.</p>}
            {selectedImport.reconciliation.status === "matched" && <p className="success">
              Running balances reconcile across {selectedImport.reconciliation.checkedRows} row transitions. Implied opening {selectedImport.reconciliation.openingBalanceMinor === null ? "unavailable" : money(selectedImport.reconciliation.openingBalanceMinor,importCurrency)}; closing {selectedImport.reconciliation.reportedClosingBalanceMinor === null ? "unavailable" : money(selectedImport.reconciliation.reportedClosingBalanceMinor,importCurrency)}.
            </p>}
            {selectedImport.reconciliation.status === "incomplete" && <p className="error" role="status">
              Balance reconciliation is incomplete. Missing balance rows: {selectedImport.reconciliation.missingBalanceRows.length}; invalid balance rows: {selectedImport.reconciliation.invalidBalanceRows.length}; invalid transaction rows: {selectedImport.reconciliation.invalidRows.length}. No balances were adjusted.
            </p>}
            {selectedImport.reconciliation.status === "discrepancy" && <div className="error" role="alert">
              <p>Statement balances do not reconcile. No balances were adjusted; review these differences before posting.</p>
              {selectedImport.reconciliation.discrepancies.map((difference) => <p key={difference.rowNumber}>
                Row {difference.rowNumber}: expected {money(difference.expectedBalanceMinor,importCurrency)}, statement shows {money(difference.reportedBalanceMinor,importCurrency)} (difference {money(difference.differenceMinor,importCurrency)}).
              </p>)}
            </div>}
            <table><thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th><th>State</th></tr></thead>
              <tbody>{selectedImport.rows.map((row) => <tr key={row.id}><td>{row.transaction_date}</td><td>{row.raw_description}</td><td>{money(row.debit_minor,importCurrency)}</td><td>{money(row.credit_minor,importCurrency)}</td><td>{row.balance_minor == null ? "—" : money(row.balance_minor,importCurrency)}</td><td>{row.duplicate_status === "duplicate" ? "duplicate" : row.validation_status}</td></tr>)}</tbody>
            </table>
            {importRequiresAcknowledgement && selectedImport.batch.status === "draft" && <label>
              <span><input type="checkbox" checked={acknowledgeReconciliation} onChange={(event) => setAcknowledgeReconciliation(event.target.checked)} /> I reviewed the balance warning and want to continue without adjusting balances.</span>
            </label>}
            <div className="modal-actions">
              <button className="text" onClick={() => setSelectedImport(null)}>Close</button>
              {selectedImport.batch.status === "draft" && <>
                <button className="text" onClick={cancelImport}>Cancel import</button>
                <button className="primary" onClick={approveAndConfirm} disabled={importRequiresAcknowledgement && !acknowledgeReconciliation}>Approve rows and post</button>
              </>}
            </div>
          </article>}
        </section>}
      </main>
      {modal && <Modal mode={modal} accounts={accounts} categories={categories} onClose={() => setModal(null)} onSaved={() => {
        setModal(null);
        refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Could not refresh account data."));
      }} />}
      {editingTransaction && <EditTransactionModal transaction={editingTransaction} categories={categories} onClose={() => setEditingTransaction(null)} onSaved={() => {
        setEditingTransaction(null);
        refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Could not refresh account data."));
      }} />}
      {editingBudget && <BudgetEditModal budget={editingBudget} categories={categories} onClose={() => setEditingBudget(null)} onSaved={() => {
        setEditingBudget(null);
        refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Could not refresh account data."));
      }} />}
      {paymentInstallment && <InstallmentPaymentModal installment={paymentInstallment} accounts={accounts} currency={paymentCurrency} onClose={() => setPaymentInstallment(null)} onSaved={recordInstallmentPayment} />}
      {cardAction && <CreditCardActionModal
        card={cardAction.card}
        mode={cardAction.mode}
        accounts={accounts}
        categories={categories}
        onClose={() => setCardAction(null)}
        onSaved={() => {
          setCardAction(null);
          setSelectedCardStatement(null);
          refresh().catch((cause) => setCardError(cause instanceof Error ? cause.message : "Could not refresh credit card data."));
        }}
      />}
    </div>
  );
}

function Balance({ accountId, currency }: { accountId: string; currency: string }) {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => { api<{ balanceMinor: number }>(`/api/v1/accounts/${accountId}/balance`).then((data: { balanceMinor: number }) => setBalance(data.balanceMinor)).catch(() => setBalance(null)); }, [accountId]);
  return <strong className="balance">{balance === null ? "Loading..." : money(balance, currency)}</strong>;
}

function BudgetCard({ budget, onEdit, onArchive }: { budget: Budget; onEdit: () => void; onArchive: () => void }) {
  const [performance, setPerformance] = useState<BudgetPerformance | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<BudgetPerformance>(`/api/v1/budgets/${budget.id}/performance`)
      .then((result) => { if (active) setPerformance(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load category budget performance."); });
    return () => { active = false; };
  }, [budget.id]);

  const spent = Number(budget.spent_minor ?? 0);
  const remaining = budget.total_limit_minor - spent;
  const utilization = budget.total_limit_minor > 0
    ? Math.min(100, (spent / budget.total_limit_minor) * 100)
    : 0;
  return <article className="card account-card">
    <div className="budget-actions"><button className="text" onClick={onEdit}>Edit</button><button className="text" onClick={onArchive}>Archive</button></div>
    <p>{budget.period_type} · {budget.start_date} – {budget.end_date}</p>
    <h3>{budget.name}</h3>
    {budget.category_names && <small className="muted">{budget.category_names}</small>}
    <div className="budget-values"><span>Spent <b>{money(spent, budget.currency)}</b></span><span>Limit <b>{money(budget.total_limit_minor, budget.currency)}</b></span></div>
    <div className={`bar ${spent > budget.total_limit_minor ? "over-budget" : "expense"}`} role="progressbar" aria-valuenow={Math.round(utilization)} aria-valuemin={0} aria-valuemax={100} aria-label={`${budget.name} budget used`}>
      <i style={{ width: `${utilization}%` }} />
    </div>
    <p className={remaining < 0 ? "error" : "muted"}>{remaining < 0 ? "Over budget by" : "Remaining"} {money(Math.abs(remaining), budget.currency)}</p>
    {performance?.categoryAllocations.map((allocation) => {
      const progress = Math.min(100, allocation.utilizationPercent);
      return <div className="allocation-performance" key={allocation.categoryId}>
        <div className="budget-values"><span>{allocation.categoryName}</span><b>{money(allocation.spentMinor, budget.currency)} / {money(allocation.limitMinor, budget.currency)}</b></div>
        <div className={`bar ${allocation.spentMinor > allocation.limitMinor ? "over-budget" : "expense"}`} role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label={`${allocation.categoryName} allocation used`}>
          <i style={{ width: `${progress}%` }} />
        </div>
        <small className={allocation.remainingMinor < 0 ? "error" : "muted"}>
          {allocation.remainingMinor < 0 ? "Over allocation by" : "Allocation remaining"} {money(Math.abs(allocation.remainingMinor), budget.currency)}
        </small>
      </div>;
    })}
    {error && <p className="error">{error}</p>}
  </article>;
}

function InstallmentPaymentModal({ installment, accounts, currency, onClose, onSaved }: {
  installment: Installment;
  accounts: Account[];
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const paymentAccounts = accounts.filter((account) =>
    ["bank", "cash", "investment"].includes(account.account_type) && account.currency === currency,
  );
  const [paymentAccountId, setPaymentAccountId] = useState(
    paymentAccounts[0]?.id ?? "",
  );
  const [principal, setPrincipal] = useState(String(installment.scheduled_principal_minor / 100));
  const [interest, setInterest] = useState(String(installment.scheduled_interest_minor / 100));
  const [fees, setFees] = useState(String(installment.scheduled_fees_minor / 100));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const availableAccounts = paymentAccounts;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/v1/installments/${installment.id}/payment`, {
        method: "POST",
        body: JSON.stringify({
          paymentAccountId,
          principalMinor: Math.round(Number(principal) * 100),
          interestMinor: Math.round(Number(interest) * 100),
          feesMinor: Math.round(Number(fees) * 100),
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record installment payment.");
    } finally {
      setSaving(false);
    }
  };
  return <div className="backdrop" role="dialog" aria-modal="true">
    <form className="card modal" onSubmit={submit}>
      <h2>Record EMI payment</h2>
      <p className="muted">Installment #{installment.installment_number} · due {installment.due_date} · scheduled {money(installment.scheduled_total_minor, currency)}</p>
      <label>Payment account<select value={paymentAccountId} onChange={(event) => setPaymentAccountId(event.target.value)} required>
        {availableAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select></label>
      {availableAccounts.length === 0 && <p className="error">Add an active bank, cash, or investment account in the installment currency first.</p>}
      <label>Principal paid<input type="number" min="0" step="0.01" value={principal} onChange={(event) => setPrincipal(event.target.value)} required /></label>
      <label>Interest paid<input type="number" min="0" step="0.01" value={interest} onChange={(event) => setInterest(event.target.value)} required /></label>
      <label>Fees paid<input type="number" min="0" step="0.01" value={fees} onChange={(event) => setFees(event.target.value)} required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="text" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving || availableAccounts.length === 0}>{saving ? "Saving..." : "Post payment"}</button></div>
    </form>
  </div>;
}

function BudgetEditModal({ budget, categories, onClose, onSaved }: {
  budget: Budget;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(budget.name);
  const [limit, setLimit] = useState(String(budget.total_limit_minor / 100));
  const [startDate, setStartDate] = useState(budget.start_date);
  const [endDate, setEndDate] = useState(budget.end_date);
  const [allocations, setAllocations] = useState<BudgetAllocation[]>([]);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailLoadCount, setDetailLoadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    setDetailError("");
    api<{ categoryAllocations: Array<{ category_id: string; limit_minor: number }> }>(`/api/v1/budgets/${budget.id}`)
      .then((detail) => setAllocations(detail.categoryAllocations.map((item) => ({
        categoryId: item.category_id,
        limitMinor: Number(item.limit_minor),
      }))))
      .catch((cause) => setDetailError(cause instanceof Error ? cause.message : "Could not load budget details."))
      .finally(() => setLoading(false));
  }, [budget.id, detailLoadCount]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/v1/budgets/${budget.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          totalLimitMinor: Math.round(Number(limit) * 100),
          startDate,
          endDate,
          categoryAllocations: allocations,
        }),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update budget.");
    } finally {
      setSaving(false);
    }
  };

  return <div className="backdrop" role="dialog" aria-modal="true">
    <form className="card modal" onSubmit={submit}>
      <h2>Edit budget</h2>
      <label>Budget name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Limit ({budget.currency})<input type="number" min="0.01" step="0.01" value={limit} onChange={(event) => setLimit(event.target.value)} required /></label>
      <label>Start date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>
      <label>End date<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>
      <fieldset className="budget-allocations">
        <legend>Category allocations</legend>
        <p className="muted">Leave all categories unchecked to track every expense.</p>
        {categories.filter((category) => category.category_type === "expense").map((category) => {
          const allocation = allocations.find((item) => item.categoryId === category.id);
          return <div className="allocation-row" key={category.id}>
            <label className="allocation-toggle">
              <input type="checkbox" checked={Boolean(allocation)} onChange={(event) => setAllocations((current) => event.target.checked
                ? [...current, { categoryId: category.id, limitMinor: 0 }]
                : current.filter((item) => item.categoryId !== category.id))} />
              {category.name}
            </label>
            {allocation && <label className="allocation-limit">Limit ({budget.currency})
              <input type="number" min="0.01" step="0.01" required value={allocation.limitMinor ? allocation.limitMinor / 100 : ""}
                onChange={(event) => setAllocations((current) => current.map((item) => item.categoryId === category.id
                  ? { ...item, limitMinor: Math.round(Number(event.target.value) * 100) }
                  : item))} />
            </label>}
          </div>;
        })}
      </fieldset>
      {detailError && <p className="error" role="alert">{detailError} <button type="button" className="text" onClick={() => setDetailLoadCount((count) => count + 1)}>Retry</button></p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="text" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={loading || saving || Boolean(detailError)}>{loading ? "Loading..." : saving ? "Saving..." : "Save budget"}</button></div>
    </form>
  </div>;
}

function EditTransactionModal({ transaction, categories, onClose, onSaved }: {
  transaction: Transaction;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(transaction.description ?? "");
  const [categoryId, setCategoryId] = useState(transaction.category_id ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/v1/transactions/${transaction.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          description: description.trim() || null,
          categoryId: categoryId || null,
        }),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save transaction details.");
    } finally {
      setSaving(false);
    }
  };
  const options = categories.filter((category) => category.category_type === transaction.transaction_type);
  return <div className="backdrop" role="dialog" aria-modal="true">
    <form className="card modal" onSubmit={submit}>
      <h2>Edit transaction details</h2>
      <p className="muted">Posted amounts and dates cannot be changed here. Financial corrections require a reversal.</p>
      <label>Description<input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
        <option value="">Uncategorized</option>
        {options.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="text" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving}>{saving ? "Saving..." : "Save details"}</button></div>
    </form>
  </div>;
}

function FeaturePlaceholder({ name }: { name: string }) {
  return <section className="card empty"><h2>{name}</h2><p>Use the API endpoints below to complete this module. Basic account and transaction workflows are ready.</p></section>;
}

function CreditCardActionModal({ card, mode, accounts, categories, onClose, onSaved }: {
  card: Card;
  mode: "purchase" | "payment";
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const paymentAccounts = accounts.filter((account) =>
    ["bank", "cash"].includes(account.account_type) && account.currency === card.currency);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState(
    paymentAccounts.find((account) => account.id === card.linked_payment_account_id)?.id ?? paymentAccounts[0]?.id ?? "",
  );
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      if (mode === "purchase") {
        await api("/api/v1/transactions", {
          method: "POST",
          body: JSON.stringify({
            transactionType: "expense",
            amountMinor: Math.round(Number(amount) * 100),
            currency: card.currency,
            accountId: card.account_id,
            ...(categoryId ? { categoryId } : {}),
            description,
            transactionAt: new Date().toISOString(),
            idempotencyKey: crypto.randomUUID(),
          }),
        });
      } else {
        await api(`/api/v1/credit-cards/${card.id}/payment`, {
          method: "POST",
          body: JSON.stringify({
            paymentAccountId,
            amountMinor: Math.round(Number(amount) * 100),
            paymentAt: new Date().toISOString(),
            idempotencyKey: crypto.randomUUID(),
          }),
        });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save credit card activity.");
    }
  };
  return <div className="backdrop" role="dialog" aria-modal="true">
    <form className="card modal" onSubmit={submit}>
      <h2>{mode === "purchase" ? "Record card purchase" : "Pay credit card bill"}</h2>
      <p className="muted">{card.card_name} · outstanding {money(card.outstanding_minor, card.currency)}</p>
      {mode === "purchase" ? <>
        <label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">Uncategorized</option>
          {categories.filter((category) => category.category_type === "expense").map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select></label>
        <label>Description<input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
      </> : <label>Pay from<select value={paymentAccountId} onChange={(event) => setPaymentAccountId(event.target.value)} required>
        {paymentAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select></label>}
      <label>Amount ({card.currency})<input type="number" min="0.01" step="0.01" max={mode === "payment" ? card.outstanding_minor / 100 : undefined} value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
      {mode === "payment" && paymentAccounts.length === 0 && <p className="error">Add an active bank or cash account in {card.currency} before recording a payment.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="text" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={mode === "payment" && paymentAccounts.length === 0}>Save</button></div>
    </form>
  </div>;
}

function Modal({ mode, accounts, categories, onClose, onSaved }: {
  mode: "account" | "transaction" | "transfer" | "budget" | "loan" | "card" | "recurring";
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState("bank");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(accounts[1]?.id ?? "");
  const [type, setType] = useState("expense");
  const [categoryId, setCategoryId] = useState("");
  const [budgetAllocations, setBudgetAllocations] = useState<Array<{ categoryId: string; limitMinor: number }>>([]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10));
  const [lender, setLender] = useState("");
  const [interest, setInterest] = useState("0");
  const [cardIssuer, setCardIssuer] = useState("");
  const [limit, setLimit] = useState("");
  const [statementDay, setStatementDay] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [linkedPaymentAccountId, setLinkedPaymentAccountId] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [intervalValue, setIntervalValue] = useState("1");
  const [recurrenceEndDate, setRecurrenceEndDate] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      if (mode === "account") {
        await api<{ id: string }>("/api/v1/accounts", {
          method: "POST",
          body: JSON.stringify({
            name,
            accountType,
            currency: "INR",
            openingDate: new Date().toISOString(),
            ...(Number(amount) !== 0 ? { openingBalanceMinor: Math.round(Number(amount) * 100) } : {}),
          }),
        });
      } else if (mode === "transaction") {
        await api("/api/v1/transactions", {
          method: "POST",
          body: JSON.stringify({
            transactionType: type,
            amountMinor: Math.round(Number(amount) * 100),
            currency: "INR",
            accountId,
            ...(categoryId ? { categoryId } : {}),
            description,
            transactionAt: new Date().toISOString(),
            idempotencyKey: crypto.randomUUID(),
          }),
        });
      } else if (mode === "recurring") {
        await api("/api/v1/recurring-rules", {
          method: "POST",
          body: JSON.stringify({
            transactionType: type,
            amountMinor: Math.round(Number(amount) * 100),
            currency: accounts.find((account) => account.id === accountId)?.currency ?? "INR",
            accountId,
            ...(categoryId ? { categoryId } : {}),
            frequency,
            intervalValue: Number(intervalValue),
            startDate,
            ...(recurrenceEndDate ? { endDate: recurrenceEndDate } : {}),
            autoPostPolicy: "manual_confirmation",
          }),
        });
      } else if (mode === "transfer") {
        await api("/api/v1/transfers", {
          method: "POST",
          body: JSON.stringify({
            fromAccountId: accountId,
            toAccountId,
            amountMinor: Math.round(Number(amount) * 100),
            currency: "INR",
            description,
            idempotencyKey: crypto.randomUUID(),
          }),
        });
      } else if (mode === "budget") {
        await api("/api/v1/budgets", {
          method: "POST",
          body: JSON.stringify({
            name,
            periodType: "monthly",
            startDate,
            endDate,
            totalLimitMinor: Math.round(Number(amount) * 100),
            currency: "INR",
            categoryAllocations: budgetAllocations,
          }),
        });
      } else if (mode === "loan") {
        await api("/api/v1/loans", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            lenderName: lender,
            loanType: "personal",
            originalPrincipalMinor: Math.round(Number(amount) * 100),
            interestRate: interest,
            startDate,
            tenureMonths: 12,
          }),
        });
      } else if (mode === "card") {
        await api("/api/v1/credit-cards", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            issuer: cardIssuer,
            cardName: name,
            creditLimitMinor: Math.round(Number(limit) * 100),
            ...(statementDay ? { statementDay: Number(statementDay) } : {}),
            ...(dueDay ? { dueDay: Number(dueDay) } : {}),
            ...(linkedPaymentAccountId ? { linkedPaymentAccountId } : {}),
          }),
        });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    }
  };
  return (
    <div className="backdrop" role="dialog" aria-modal="true">
      <form className="card modal" onSubmit={submit}>
        <h2>{mode === "account" ? "Add account" : mode === "transaction" ? "Add transaction" : mode === "transfer" ? "Transfer money" : mode === "recurring" ? "Add recurring rule" : `Add ${mode}`}</h2>
        {mode === "account" ? <>
          <label>Account name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Account type<select value={accountType} onChange={(e) => setAccountType(e.target.value)}><option value="bank">Bank</option><option value="cash">Cash</option><option value="credit_card">Credit card</option><option value="loan">Loan</option><option value="investment">Investment</option></select></label>
          <label>Opening balance (₹)<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        </> : mode === "transaction" ? <>
          <label>Transaction type<select value={type} onChange={(e) => setType(e.target.value)}><option value="expense">Expense</option><option value="income">Income</option></select></label>
          <label>Account<select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>Category<select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Uncategorized</option>{categories.filter((category) => category.category_type === type).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label>Amount (₹)<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
          <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        </> : mode === "recurring" ? <>
          <p className="muted">This creates a reminder rule only. Confirm each occurrence before it posts to your ledger.</p>
          <label>Transaction type<select value={type} onChange={(event) => setType(event.target.value)}><option value="expense">Expense</option><option value="income">Income</option></select></label>
          <label>Account<select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Uncategorized</option>{categories.filter((category) => category.category_type === type).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label>Amount (₹)<input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
          <label>Frequency<select value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
          <label>Every N periods<input type="number" min="1" step="1" value={intervalValue} onChange={(event) => setIntervalValue(event.target.value)} required /></label>
          <label>Start date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>
          <label>End date (optional)<input type="date" value={recurrenceEndDate} onChange={(event) => setRecurrenceEndDate(event.target.value)} /></label>
        </> : mode === "transfer" ? <>
          <label>From<select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>To<select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>Amount (₹)<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
          <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        </> : mode === "budget" ? <>
          <label>Budget name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Limit (₹)<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
          <fieldset className="budget-allocations">
            <legend>Optional category allocations</legend>
            <p className="muted">Leave all categories unchecked to track every expense.</p>
            {categories.filter((category) => category.category_type === "expense").map((category) => {
              const allocation = budgetAllocations.find((item) => item.categoryId === category.id);
              return <div className="allocation-row" key={category.id}>
                <label className="allocation-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(allocation)}
                    onChange={(event) => setBudgetAllocations((current) => event.target.checked
                      ? [...current, { categoryId: category.id, limitMinor: 0 }]
                      : current.filter((item) => item.categoryId !== category.id))}
                  />
                  {category.name}
                </label>
                {allocation && <label className="allocation-limit">Limit (₹)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={allocation.limitMinor ? allocation.limitMinor / 100 : ""}
                    onChange={(event) => setBudgetAllocations((current) => current.map((item) =>
                      item.categoryId === category.id
                        ? { ...item, limitMinor: Math.round(Number(event.target.value) * 100) }
                        : item))}
                    required
                  />
                </label>}
              </div>;
            })}
          </fieldset>
          <label>Start date<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required /></label>
          <label>End date<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required /></label>
        </> : mode === "loan" ? <>
          <label>Lender<input value={lender} onChange={(e) => setLender(e.target.value)} required /></label>
          <label>Loan liability account<select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.filter((account) => account.account_type === "loan").map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>Principal (₹)<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
          <label>Interest rate (%)<input type="number" min="0" step="0.01" value={interest} onChange={(e) => setInterest(e.target.value)} /></label>
          <label>Start date<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required /></label>
        </> : <>
          <label>Card name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Issuer<input value={cardIssuer} onChange={(e) => setCardIssuer(e.target.value)} /></label>
          <label>Credit card account<select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.filter((account) => account.account_type === "credit_card").map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>Credit limit (₹)<input type="number" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} required /></label>
          <label>Statement day<input type="number" min="1" max="31" value={statementDay} onChange={(e) => setStatementDay(e.target.value)} /></label>
          <label>Payment due day<input type="number" min="1" max="31" value={dueDay} onChange={(e) => setDueDay(e.target.value)} /></label>
          <label>Default payment account<select value={linkedPaymentAccountId} onChange={(e) => setLinkedPaymentAccountId(e.target.value)}>
            <option value="">No default</option>
            {accounts.filter((account) => ["bank", "cash"].includes(account.account_type) && account.currency === (accounts.find((item) => item.id === accountId)?.currency ?? "INR")).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select></label>
        </>}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions"><button type="button" className="text" onClick={onClose}>Cancel</button><button type="submit" className="primary">Save</button></div>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
