# EA EarnHub — full-stack MVP

EA EarnHub is a mobile-responsive task-and-rewards website starter with a Node.js/Express backend and SQLite database. It includes registration/login, package requests, task submissions, wallet ledger, withdrawal requests, and admin review endpoints.

## Included package rules
- Bronze: KSh 50 access fee / advertised activity value up to KSh 150
- Silver: KSh 100 / up to KSh 250
- Gold: KSh 150 / up to KSh 350
- Platinum: KSh 200 / up to KSh 500
- Minimum withdrawal: KSh 100
- Maximum requested withdrawal total per day: KSh 1,000
- Withdrawal fee: 6% (KSh 100 request estimates KSh 94 payout)

**Displayed values are not guaranteed income.** Only pay users from real, documented, funded rewards. The app intentionally does not allow the browser to credit balances. Tasks must be marked as funded by an administrator and reviewed before rewards are credited.

## Run locally
Requires Node.js 20 or newer.

1. Extract the ZIP.
2. Copy `.env.example` to `.env`.
3. Set `JWT_SECRET` to a long random secret (32+ characters) and `ADMIN_KEY` to a separate random secret (24+ characters).
4. Install dependencies:
   ```bash
   npm install
   ```
5. Start:
   ```bash
   npm start
   ```
6. Open `http://localhost:3000`.

SQLite database is created automatically in `data/earnhub.sqlite`. Do not delete the `data` folder if you want to keep accounts and transactions.

## Admin review API
Use these endpoints with an `x-admin-key` header. Keep the key server-side and never put it in public frontend JavaScript.

- `GET /api/admin/overview`
- `GET /api/admin/pending`
- `POST /api/admin/packages/:id/verify` with JSON `{"approve":true}` or `{"approve":false}`
- `POST /api/admin/tasks/:id/funding` with JSON `{"funded":true}` or `{"funded":false}`
- `POST /api/admin/submissions/:id/review` with JSON `{"approve":true}` or `{"approve":false}`
- `POST /api/admin/withdrawals/:id/review` with JSON `{"status":"paid"}` or `{"status":"rejected"}`

Example local admin request:
```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" http://localhost:3000/api/admin/pending
```

Only mark a withdrawal `paid` after confirming that the M-Pesa payout really succeeded. The included admin endpoints are a starter, not a full visual admin panel; add an authenticated admin UI and audit logging before production.

## M-Pesa integration status
**Not connected to live M-Pesa.** Package purchase requests remain `pending`; the browser cannot confirm a payment. To go live:
1. Register for Safaricom Daraja and obtain sandbox credentials.
2. Implement server-side STK Push initiation and a publicly reachable HTTPS callback endpoint.
3. Validate callback result codes and transaction references; make callbacks idempotent; verify amount, shortcode, and account/reference against a pending purchase.
4. Only after confirmed payment, activate the package. Never accept a payment-success flag from the frontend.
5. For withdrawals, implement approved Safaricom B2C disbursements, callback verification, idempotency, reconciliation, and a manual fallback process.
6. Store secrets only in deployment environment variables. Use HTTPS, backups, monitoring, fraud controls, and logs with sensitive data redacted.

## Before public launch
- Add email/phone verification, password reset, CSRF protections appropriate to the chosen auth design, session revocation, stricter rate limits, and audit logs.
- Build an admin web interface with roles and audit history.
- Connect a legitimate survey/game provider under its terms; the seeded survey is clearly a demo.
- Publish clear Terms, Privacy Policy, refund rules, eligibility and payout terms.
- Confirm Kenyan legal, tax, consumer-protection, data-protection, and payment-provider requirements with qualified local advice.
- Do not advertise guaranteed profit, use referral fees as the only source of payouts, or accept deposits unless the business model and applicable requirements have been reviewed.
- Use a production database and scheduled encrypted backups if the service grows beyond a prototype.

## Main API
- `GET /api/health`
- `GET /api/packages`
- `GET /api/tasks`
- `POST /api/register`
- `POST /api/login`
- `GET /api/me` (Bearer token)
- `POST /api/packages/:id/purchase` (Bearer token)
- `POST /api/tasks/:id/submit` (Bearer token)
- `POST /api/withdrawals` (Bearer token)

This is a functioning MVP foundation, not yet a production payment service. Test all money flows in sandbox before handling real customer funds.
