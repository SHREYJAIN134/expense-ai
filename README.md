# Expense AI

A **private, single-user personal-finance analytics app** for HDFC bank statements. Upload a (password-protected) statement PDF, and it is decrypted and parsed on the server, normalised, de-duplicated, classified, stored in a relational database, and turned into analytics, charts, insights, forecasts and a data-grounded AI assistant.

It is **not** connected to HDFC NetBanking and never asks for bank credentials - you upload statements manually.

## Contents
- [Quick start](#quick-start) · [Commands](#commands) · [Environment variables](#environment-variables)
- [Architecture](#architecture) · [Folder structure](#folder-structure) · [Database schema](#database-schema)
- [HDFC parser](#hdfc-parser-architecture) · [Classification](#classification--ai-architecture) · [Analytics definitions](#analytics-definitions) · [Assistant](#the-assistant)
- [Security](#security-considerations) · [Testing](#testing) · [Deployment](#production-deployment) · [Limitations](#known-limitations)

## Quick start
```bash
npm install
cp .env.example .env.local        # optional in dev - see below
npm run dev                       # http://localhost:3000
```
1. Open the app - the first visit shows **Create your account** (sign-up closes once an account exists).
2. Try it with **Load demo data** (dashboard onboarding card or Settings) - clearly labelled *synthetic* data, removable any time.
3. Or upload a statement. Two synthetic PDFs (one password-protected, password `demo1234`) are in `samples/` (`npm run sample:pdf` regenerates them).

No `AUTH_SECRET` is needed in development (a random one is generated into `data/.auth-secret`, git-ignored). In production it is **required**.

## Commands
| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server / production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Next + TypeScript rules) |
| `npm test` | Vitest (parser incl. real-HDFC-structure fixtures, pipeline, analytics, chat, security audit) |
| `npm run validate` | typecheck + lint + tests |
| `npm run db:migrate` | Apply migrations (also runs automatically on first DB access) |
| `npm run db:where` | Print where the database/secret will live and whether that is a cloud-synced folder |
| `npm run sample:pdf` | Regenerate the synthetic sample statements in `samples/` |
| `BASE_URL=… npx tsx scripts/e2e.ts` | HTTP end-to-end smoke test against a running server (use a **throwaway** `DATABASE_URL`) |

## Environment variables
See `.env.example`. Nothing secret is ever committed.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Explicit SQLite file. **Leave unset** - the default is `./data/expense-ai.db`, or a per-user local app-data folder when the project sits in OneDrive/Dropbox/etc. (see [Database location](#database-location)) |
| `EXPENSE_AI_DATA_DIR` | Explicit data directory (database + dev secret) |
| `AUTH_SECRET` | ≥32 chars; keys the session-token HMAC. Required in production |
| `ALLOW_REGISTRATION` | `true` to allow a second account (default: sign-up only while no user exists) |
| `SESSION_TTL_DAYS` | Sliding session lifetime (default 14) |
| `COOKIE_SECURE` | Set `false` only if you serve production over plain HTTP on a LAN |
| `TRUST_PROXY` | `true` when behind your own reverse proxy (uses `X-Forwarded-For` for rate limiting) |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | Optional LLM (Anthropic or OpenAI-compatible). Server-side only. Empty key = fully local |

## Architecture
```
Browser (React client components, Recharts)
   │  fetch JSON / streamed NDJSON            ← no secrets, no financial data in source
Next.js route handlers  (src/app/api/**)      ← every route wrapped by `route()`: auth, CSRF origin check,
   │                                             rate limit, zod validation, safe errors
Services (src/lib/services, pipeline, chat)   ← DB access, caching, orchestration
   ├─ parsers/        PDF → text items → HDFC table parser → normaliser
   ├─ classification/ rules → merchants → history → keywords → (optional) AI, with confidence
   ├─ analytics/      PURE functions over TxnLite[]: summary, periods, categories, recurring, forecast, budgets, insights
   ├─ chat/           question → intent → analytics/DB → grounded answer → (optional) LLM phrasing + number verification
   └─ auth/           bcrypt, DB-backed sessions, rate limiting, CSRF
SQLite (better-sqlite3, WAL, foreign keys ON)
```
**Tech stack:** Next.js 16 (App Router) · React 19 · TypeScript · SQLite (better-sqlite3) · pdfjs-dist (server-side PDF text + decryption) · Recharts + custom SVG/CSS heatmaps · zod · bcryptjs · Vitest · pdfkit (dev-only, to generate synthetic test PDFs).

Design choices worth knowing:
- **Analytics are pure and server-side.** The UI only renders structured payloads. Aggregations run over compact rows loaded once per data-version and memoised (`services/data.ts`); every write bumps the version.
- **Amounts** are stored as rupees rounded to 2 decimals with `round2` at aggregation edges (float-drift tests included). Dates are ISO `YYYY-MM-DD` text and date maths is UTC-only.
- **Imports are two-phase:** *upload* parses + previews (rows staged, nothing in `transactions`), *process* inserts atomically in one SQLite transaction. Any error rolls everything back.
- SQLite fits a single-user private app. The schema is portable SQL; moving to Postgres means swapping `db/client.ts`.

## Folder structure
```
src/
  app/                  pages + API routes  (login/, (app)/dashboard|analytics|transactions|upload|statements|budgets|recurring|assistant|settings, api/**)
  components/           Shell, UI primitives, RangeFilter, charts/{basic,heat,shared}
  lib/
    db/                 client.ts (singleton, migrations runner), migrations.ts (versioned schema)
    auth/               password, session, secret, ratelimit, guard (route wrapper)
    parsers/            pdf-reader.ts, index.ts (registry), hdfc/{detector,layout,parser,normalizer,dates}
    classification/     merchants, keywords, classifier, ai-classifier
    analytics/          engine, recurring, planning (upcoming/forecast/budgets), insights
    pipeline/import.ts  stage → preview → confirm
    services/           users, data(cache), transactions, planning, analytics, export, demo, schemas
    chat/               period, intent, answer, llm, service
    ai/provider.ts      Anthropic / OpenAI-compatible, server-side only
    demo/synthetic.ts   deterministic synthetic transactions
    domain/, util/, client/
scripts/                migrate, sample PDF generator, e2e
tests/                  parser, normalization, classification, analytics, planning, integration
samples/                synthetic sample statements (safe to commit)
```

## Database schema
`users`, `sessions` (stores only an HMAC of the token), `user_settings`, `accounts` (last-4 digits only), `statements`, `transactions`, `transaction_categories`, `transaction_classifications` (audit trail of every decision), `merchant_overrides` (learned corrections), `budgets`, `recurring_expenses` (manual + dismissed detections), `financial_goals`, `chat_sessions`, `chat_messages`, `financial_insights`, `schema_migrations`.

Migration 2 adds `raw_narration`, `normalized_narration`, `upi_id`, `upi_bank_code`, `upi_reference`, `payment_provider`, `merchant_confidence`, `is_refund`, `refund_reference`, `is_recurring_candidate`, `recurring_confidence`, `needs_review` to `transactions`, and `official_debit_count`, `official_credit_count`, `official_total_debits`, `official_total_credits`, `calculated_closing_balance`, `reconciliation_status`, `reconciliation_json` to `statements`.

`transactions` keeps `raw_description` untouched and adds `description`, `reference_number`, `debit`, `credit`, `amount`, `direction`, `transaction_type`, `balance_after`, `merchant`, `category`, `subcategory`, `classification_confidence`, `classification_source`, `payment_method`, `is_recurring`, `notes`, `user_edited`, `dedupe_key` (unique per user), timestamps and an `is_demo` flag. See `src/lib/db/migrations.ts` for the full DDL.

## HDFC parser architecture
`pdf-reader.ts` opens the PDF with pdfjs (password in memory only; typed errors `PASSWORD_REQUIRED` / `INCORRECT_PASSWORD` / `INVALID_PDF`) and returns positioned text items. Then (`parsers/hdfc/`, parser v2):
1. **detector** - scores HDFC branding, statement wording and a recognisable table header.
2. **layout** - finds the column header per page (synonym-matched: *Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance*) and **calibrates the text columns from the data rows themselves**, so results don't depend on whether header labels are left-aligned, centred or right-aligned. Geometry is carried across pages, so a page holding only the tail of a wrapped narration still parses.
3. **parser** - a transaction starts **only** on a line whose leftmost item is a real `dd/mm/yy` date *and* that carries an amount. Everything before the table header on a page (customer block, statement period, branch, account-open date), any line with text in the DATE column (footer: HDFC BANK LIMITED, Page No, Registered Office, GST, Generated On/By, Requesting Branch Code...) and the `STATEMENT SUMMARY` block are excluded. Continuation lines (wrapped narration/ref) attach to the open transaction, **including across page breaks**. HDFC wraps at a fixed width (word wrap; a token longer than the line is hard-broken mid-token): the wrap width is estimated statistically and hard breaks are re-joined without a space, word wraps with one. Both the original line breaks (`raw_narration`) and the joined text are kept.
4. **statement summary + reconciliation** (`reconcile.ts`) - the bank's own `STATEMENT SUMMARY` (opening balance, Dr/Cr count, debits, credits, closing) is extracted as its own object and **compared** with totals independently calculated from the parsed rows: debit/credit counts, totals, `opening + credits - debits = closing`, closing = last-row balance, and the **running balance chain row by row**. Result: `reconciled` / `mismatch` / `no_summary`, with the individual checks and issues. A debit/credit side is only repaired when the running balance proves it, and every repair is flagged. **Nothing is trusted silently**: a `mismatch` requires the user to explicitly acknowledge before import.
5. **normaliser** - typed transactions; the **Chq./Ref.No. column verbatim** (leading zeros kept, never merged into the narration; the 12-digit RRN inside a UPI narration is stored separately as `upi_reference`); **transaction date and value date kept separate**; debit XOR credit; and `upi.ts` UPI intelligence: merchant, UPI id, bank code, RRN, note, `AUTOPAY` mandates, refund wording and the **payment provider** (Razorpay / Paytm / Google Pay / PhonePe... inferred from the handle) - which is *never* treated as the merchant.
6. **dedupe key** = hash(txn date, value date, direction, amount, normalised narration, reference, balance) + occurrence index. Direction is part of the key, so a Rs 266 debit and its Rs 266 refund credit are different transactions. At import, an existing row with the same **reference + direction + amount + date** is also treated as the same transaction even if the narration was re-wrapped differently.

Adding another bank = implement `BankParser` and register it in `parsers/index.ts`.

### Refunds, AUTOPAY, review flags
- **Refunds:** a `REFUNDS` credit is linked (`refund_reference`) to the earlier debit of the same merchant (same or larger amount, within 90 days, preferring an exact amount). Merchant/category analytics and the assistant **net the refund against its purchase** (Blinkit 266 + 266 refund = 0). Unlinked refunds stay flagged `is_refund`.
- **AUTOPAY:** `UPI-AUTOPAY-<merchant>` and ACH/NACH debits get `payment_method = AUTOPAY` and `is_recurring_candidate` at low `recurring_confidence` (one payment is weak evidence); confidence rises only when history shows a real pattern.
- **`needs_review`:** low confidence, gateway-only merchants (`NEEDS_REVIEW`), or parser warnings.

## Classification / AI architecture
Pipeline per transaction (first confident hit wins): **user corrections → structural rules (ATM, fees, interest, salary/rent words, EMI, reversals) → known-merchant dictionary → history (this merchant was consistently classified before) → keyword analysis → person-transfer/probable-salary heuristics → OTHER/Unclassified (confidence 0.35–0.4)**. After import, regular unclassified payments are promoted by recurring-pattern detection.

Only rows still ambiguous (`OTHER`, confidence < 0.5) are sent to the optional AI provider, **as a cleaned merchant/narration snippet + debit/credit direction only** (no amounts, dates, references, account numbers, VPAs or PDFs). Responses are validated against the taxonomy, confidence is capped at 0.8, and any failure leaves the row `OTHER / Unclassified` - imports are never blocked. Correcting a transaction stores a `merchant_overrides` row that re-classifies siblings and all future imports (confidence 0.99, "Your correction").

Merchant normalisation is separate from categorisation, so `SWIGGY`, `SWIGGY*12345`, `SWIGGY ONLINE` → *Swiggy* while *Swiggy Instamart* stays distinct.

## Analytics definitions
- **Income** = credits categorised `SALARY/INCOME`. **Refunds** = `REFUNDS` credits (reduce net spending). Transfers in/out and investments are money movement, *not* income/spending. **Spending** = debits excluding `TRANSFERS`/`INVESTMENTS`. **Net cash flow** = credits − debits. **Savings** = income − net spending.
- Daily / ISO-weekly / monthly / quarterly / yearly aggregation for income, spending, net; category, sub-category and merchant breakdowns. Years are derived from data. Settings → *financial month starts on day N* shifts monthly/quarterly buckets, budgets and "this month".
- **Recurring detection**: same merchant, ≥3 occurrences (or a clean fixed monthly pair), median interval → weekly/biweekly/monthly/quarterly/yearly, regularity + amount-variability + count → confidence; discretionary variable categories are excluded. Provides last/next expected dates; series with no payment for >2 cycles are marked *possibly ended*.
- **Upcoming/forecast** combine detected series with manual obligations (manual overrides duplicates). Everything forward-looking is labelled **Estimate** and lists its assumptions; nothing is presented as a guaranteed balance.
- **Anomalies**: per-category median/MAD modified z-score (>3.5), robust to a single huge purchase.

## The assistant
`question → intent/period/category/merchant extraction (deterministic) → analytics/DB query → deterministic answer + structured facts → optional LLM phrasing → response`. The LLM receives only computed facts, and a verifier discards any output containing a number not present in those facts. Without an API key, the deterministic answer is used. Financial facts always come from the *current* database; chat history is stored only for context (e.g. "what about last month?") and display. Handles the spec's example questions including *safe to spend*, *can I afford ₹X*, *what remains after rent + electricity*, and next-month cash requirement, each broken into balance / expected income / recurring / everyday spending / remaining.

## Database location
This project can live in a cloud-synced folder (OneDrive), but **the live database must not**: sync clients rewrite/lock files mid-transaction, SQLite's WAL mode uses three files (`.db`, `-wal`, `-shm`) that must stay consistent, and your financial data would be copied to a cloud account. So by default, when the project path is inside OneDrive/Dropbox/Google Drive/iCloud, the database **and the dev auth secret** are stored in a per-user local folder (Windows: `%LOCALAPPDATA%\ExpenseAI`, macOS: `~/Library/Application Support/ExpenseAI`, Linux: `~/.local/share/expense-ai`). Override with `DATABASE_URL` / `EXPENSE_AI_DATA_DIR`; explicitly pointing them into a synced folder logs a one-line path warning. Check with `npm run db:where`. Back up by copying that folder (or use *Settings -> Complete backup*).

## Security considerations
- **Auth:** bcrypt (cost 12), constant-time unknown-user path, DB-backed sessions (random 256-bit token; only an HMAC is stored), `HttpOnly` + `SameSite=Lax` (+`Secure` in production) cookie, sliding expiry, sign-out-everywhere on password change, login rate limiting, first-user-only sign-up.
- **Every** API route re-validates the session server-side and scopes every query by `user_id`; the `proxy.ts` cookie check is only an optimistic redirect.
- **CSRF:** same-origin (`Origin`/`Sec-Fetch-Site`) enforcement on all mutating requests. **XSS:** React escaping only - no `innerHTML`; strict CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`. **SQLi:** parameterised queries, LIKE wildcards escaped, sort columns whitelisted. **CSV injection:** formula-prefix escaping on exports.
- **PDF handling:** magic-byte + extension + size (15 MB) validation; the **password is used in memory only** - never persisted, logged, echoed or included in errors (verified by tests that scan every table and response); the **PDF bytes are never stored** (only parsed rows, staged until you confirm, then cleared).
- API responses are `no-store`. Errors never include stack traces or request bodies. Destructive actions require the account password **and** a typed confirmation phrase.
- No secrets in the browser; the AI key is server-only and the AI never sees raw statements.
- Residual notes: in-memory rate limiting is per-process; CSP allows `'unsafe-inline'` scripts because of Next.js bootstrap scripts (add nonces if you want to tighten it); SQLite data is not encrypted at rest - use disk encryption / restrict file permissions for `data/`.

## Testing
`npm test` runs the full suite: PDF parsing (multi-page, two layouts, AES-128/256 encryption, wrong/missing password, corrupt/non-HDFC files), normalisation, dedupe, classification & merchants, AI classification (soft-fail, privacy of the payload), daily/weekly/monthly/quarterly/yearly aggregation, recurring detection, budgets, forecast, insights, the DB import pipeline (duplicates, overlapping statements, retention, rollback, learning, user isolation), password/session/CSRF/rate-limit primitives, and assistant retrieval verified against raw SQL. `scripts/e2e.ts` exercises the running HTTP server (auth, cookies, streamed upload, preview→import, analytics, exports, destructive flows).

## Production deployment
```bash
npm ci && npm run build
AUTH_SECRET=<48+ random chars> DATABASE_URL=/var/lib/expense-ai/expense-ai.db npm start
```
Put it behind HTTPS (Caddy/nginx/Cloudflare Tunnel) and set `TRUST_PROXY=true`. Back up the SQLite file (or use *Settings → Complete backup*). Single instance only (SQLite + in-memory cache/rate limiter). Keep `data/` out of source control and cloud-sync folders if you can.

## Known limitations
- **The parser has not yet been run on a real HDFC statement.** It is tested on synthetic statements that reproduce the structure described by the user (multi-page, repeated header/footer, wrapped UPI narrations, separate reference/value-date columns, summary block). Real PDFs may still differ - use the preview and reconciliation report to verify. **Always review the preview** - warnings appear when balances/summary totals don't reconcile. Scanned (image-only) PDFs are unsupported (no OCR). Credit-card statements are not supported.
- A hard-wrapped narration line whose length exactly equals the wrap width and which happens to break at a space is joined without that space (cosmetic; the raw lines are always kept).
- Classification of unknown merchants is heuristic; low-confidence rows are surfaced ("Needs review") and corrections are learned.
- The currency preference is stored but amounts are always formatted in ₹ (HDFC statements are INR). Forecasts are simple pattern-based estimates, not financial advice.
