# Acceptance smoke tests

1. Start the API and web application.
2. Register a new user.
3. Create a bank account.
4. Set an opening balance.
5. Add income and verify the account balance increases.
6. Add an expense and verify the account balance decreases.
7. Repeat a transaction mutation with the same idempotency key and verify no duplicate posting.
8. Create a transfer and verify consolidated net worth remains unchanged.
9. Open the web dashboard and verify summary totals.
10. Sign in from the Expo app and verify dashboard, accounts and transactions.
