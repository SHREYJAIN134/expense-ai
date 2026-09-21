/**
 * Versioned schema migrations. Append only - never edit a shipped migration.
 * Amounts are stored as REAL rupees rounded to 2 decimals (see util/money.ts);
 * dates are ISO `YYYY-MM-DD` text so they sort and range-filter lexicographically.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only a keyed hash of the session token is stored; the raw token lives in the cookie.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE user_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency           TEXT NOT NULL DEFAULT 'INR',
  month_start_day    INTEGER NOT NULL DEFAULT 1,
  ai_classification  INTEGER NOT NULL DEFAULT 1,
  ai_narration       INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank           TEXT NOT NULL DEFAULT 'HDFC',
  account_mask   TEXT NOT NULL DEFAULT 'UNKNOWN',   -- last 4 digits only, never the full number
  account_type   TEXT,
  nickname       TEXT,
  currency       TEXT NOT NULL DEFAULT 'INR',
  latest_balance REAL,
  balance_as_of  TEXT,
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, bank, account_mask)
);

CREATE TABLE statements (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id         TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  bank               TEXT NOT NULL DEFAULT 'HDFC',
  filename           TEXT NOT NULL,
  file_size          INTEGER,
  file_sha256        TEXT,
  period_start       TEXT,
  period_end         TEXT,
  status             TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','imported','failed','discarded')),
  txn_count          INTEGER NOT NULL DEFAULT 0,
  duplicates_skipped INTEGER NOT NULL DEFAULT 0,
  total_debits       REAL NOT NULL DEFAULT 0,
  total_credits      REAL NOT NULL DEFAULT 0,
  opening_balance    REAL,
  closing_balance    REAL,
  warnings_json      TEXT,
  staged_json        TEXT,             -- parsed (NOT raw PDF) rows awaiting confirmation; cleared on import
  error_message      TEXT,
  is_demo            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  imported_at        TEXT
);
CREATE INDEX idx_statements_user ON statements(user_id, period_start);

CREATE TABLE transaction_categories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  subcategory TEXT NOT NULL DEFAULT '',
  color       TEXT,
  is_system   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, category, subcategory)
);

CREATE TABLE transactions (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id                TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  statement_id              TEXT REFERENCES statements(id) ON DELETE CASCADE,
  txn_date                  TEXT NOT NULL,
  value_date                TEXT,
  posting_date              TEXT,
  seq                       INTEGER NOT NULL DEFAULT 0,      -- row order within statement
  raw_description           TEXT NOT NULL,                   -- preserved exactly as parsed
  description               TEXT NOT NULL,                   -- whitespace-normalised
  reference_number          TEXT,
  debit                     REAL NOT NULL DEFAULT 0,
  credit                    REAL NOT NULL DEFAULT 0,
  amount                    REAL NOT NULL,                   -- magnitude (always >= 0)
  direction                 TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  transaction_type          TEXT NOT NULL DEFAULT 'OTHER',
  balance_after             REAL,
  merchant                  TEXT,
  category                  TEXT NOT NULL DEFAULT 'OTHER',
  subcategory               TEXT NOT NULL DEFAULT 'Unclassified',
  classification_confidence REAL NOT NULL DEFAULT 0,
  classification_source     TEXT NOT NULL DEFAULT 'none',
  payment_method            TEXT,
  is_recurring              INTEGER NOT NULL DEFAULT 0,
  notes                     TEXT,
  user_edited               INTEGER NOT NULL DEFAULT 0,
  dedupe_key                TEXT NOT NULL,
  is_demo                   INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX idx_txn_user_date ON transactions(user_id, txn_date);
CREATE INDEX idx_txn_user_cat  ON transactions(user_id, category, txn_date);
CREATE INDEX idx_txn_user_merchant ON transactions(user_id, merchant);
CREATE INDEX idx_txn_statement ON transactions(statement_id);

-- Audit trail of every classification decision (rule / merchant / keyword / ai / user).
CREATE TABLE transaction_classifications (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant       TEXT,
  category       TEXT NOT NULL,
  subcategory    TEXT NOT NULL,
  confidence     REAL NOT NULL,
  method         TEXT NOT NULL,
  reason         TEXT,
  is_current     INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tc_txn ON transaction_classifications(transaction_id);

-- What the app learns from manual corrections.
CREATE TABLE merchant_overrides (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_key  TEXT NOT NULL,           -- normalised key of the merchant BEFORE renaming
  merchant_name TEXT,                    -- optional rename
  category      TEXT,
  subcategory   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, merchant_key)
);

CREATE TABLE budgets (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  amount          REAL NOT NULL CHECK (amount > 0),
  period          TEXT NOT NULL DEFAULT 'monthly',
  alert_threshold REAL NOT NULL DEFAULT 0.8,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, category)
);

CREATE TABLE recurring_expenses (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  merchant_key TEXT,
  category     TEXT NOT NULL DEFAULT 'BILLS',
  subcategory  TEXT,
  amount       REAL NOT NULL CHECK (amount >= 0),
  frequency    TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','yearly')),
  due_day      INTEGER,
  start_date   TEXT,
  kind         TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','detected')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dismissed')),
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_recurring_user ON recurring_expenses(user_id);

CREATE TABLE financial_goals (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  target_amount  REAL NOT NULL CHECK (target_amount > 0),
  current_amount REAL NOT NULL DEFAULT 0,
  target_date    TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT 'New chat',
  context_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chat_sessions_user ON chat_sessions(user_id, updated_at);

CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  intent     TEXT,
  data_json  TEXT,              -- structured facts the answer was computed from
  used_llm   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);

CREATE TABLE financial_insights (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','positive','warning','alert')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  data_json    TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_insights_user ON financial_insights(user_id);
`,
  },
  {
    id: 2,
    name: "hdfc_real_format_fields",
    sql: `
-- Parser hardening: richer narration/UPI/merchant/refund/review fields (additive, nothing dropped).
ALTER TABLE transactions ADD COLUMN raw_narration TEXT;             -- narration with original PDF line breaks
ALTER TABLE transactions ADD COLUMN normalized_narration TEXT;      -- upper-case alphanumeric form
ALTER TABLE transactions ADD COLUMN upi_id TEXT;
ALTER TABLE transactions ADD COLUMN upi_bank_code TEXT;
ALTER TABLE transactions ADD COLUMN upi_reference TEXT;             -- 12-digit RRN inside the narration
ALTER TABLE transactions ADD COLUMN payment_provider TEXT;          -- app/PSP/gateway (never the merchant)
ALTER TABLE transactions ADD COLUMN merchant_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN is_refund INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN refund_reference TEXT;          -- id of the original debit a refund reverses
ALTER TABLE transactions ADD COLUMN is_recurring_candidate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN recurring_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_txn_user_ref ON transactions(user_id, reference_number);
CREATE INDEX idx_txn_user_review ON transactions(user_id, needs_review);

-- The bank's own STATEMENT SUMMARY and the reconciliation result, kept next to the calculated totals.
ALTER TABLE statements ADD COLUMN official_debit_count INTEGER;
ALTER TABLE statements ADD COLUMN official_credit_count INTEGER;
ALTER TABLE statements ADD COLUMN official_total_debits REAL;
ALTER TABLE statements ADD COLUMN official_total_credits REAL;
ALTER TABLE statements ADD COLUMN calculated_closing_balance REAL;
ALTER TABLE statements ADD COLUMN reconciliation_status TEXT;
ALTER TABLE statements ADD COLUMN reconciliation_json TEXT;
`,
  },
  {
    id: 3,
    name: "financial_intelligence_settings",
    sql: `
-- V2 financial intelligence: user-tunable thresholds and safe-to-spend assumptions (additive; nothing dropped).
-- Anomalies, insights and projections are computed deterministically from transactions on demand, so no
-- derived data is stored (it can never go stale or drift from the ledger).
ALTER TABLE user_settings ADD COLUMN safety_buffer REAL;                                   -- NULL = automatic (10% of typical monthly spending)
ALTER TABLE user_settings ADD COLUMN change_min_pct REAL NOT NULL DEFAULT 25;              -- % change needed to flag a category/merchant change
ALTER TABLE user_settings ADD COLUMN change_min_amount REAL NOT NULL DEFAULT 500;          -- and at least this many rupees
ALTER TABLE user_settings ADD COLUMN change_min_txns INTEGER NOT NULL DEFAULT 3;           -- and at least this many transactions (small-sample guard)
ALTER TABLE user_settings ADD COLUMN anomaly_min_amount REAL NOT NULL DEFAULT 1000;        -- transactions below this are never flagged as unusual
ALTER TABLE user_settings ADD COLUMN include_detected_recurring INTEGER NOT NULL DEFAULT 1; -- safe-to-spend counts detected recurring payments
ALTER TABLE user_settings ADD COLUMN reserve_budgets INTEGER NOT NULL DEFAULT 1;           -- safe-to-spend reserves unspent budgets
`,
  },
  {
    id: 4,
    name: "multi_source_transactions",
    sql: `
-- Second transaction source (Google Pay) + canonical event identity. Additive and backward compatible:
-- every existing row is an HDFC row, is its own event and is primary, so nothing changes for existing data.
ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'HDFC';        -- HDFC | GOOGLE_PAY | (future: PHONEPE, PAYTM, CSV...)
ALTER TABLE transactions ADD COLUMN event_id TEXT;                              -- the real-world financial event; rows from different sources share it
ALTER TABLE transactions ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1;      -- 1 = counted by analytics; 0 = corroborating copy of another source's row
ALTER TABLE transactions ADD COLUMN txn_time TEXT;                              -- HH:MM (24h) when the source provides it
ALTER TABLE transactions ADD COLUMN txn_datetime TEXT;                          -- YYYY-MM-DDTHH:MM (statement-local time)
ALTER TABLE transactions ADD COLUMN counterparty_raw TEXT;                      -- counterparty exactly as the source printed it
ALTER TABLE transactions ADD COLUMN funding_bank TEXT;                          -- bank the payment was made from / received into (never the merchant)
ALTER TABLE transactions ADD COLUMN funding_mask TEXT;                          -- last 4 digits only
ALTER TABLE transactions ADD COLUMN semantic_type TEXT;                         -- SELF_TRANSFER | POSSIBLE_SELF_TRANSFER | PERSON_TO_PERSON | UNKNOWN_COUNTERPARTY | REFUND_REQUIRES_REVIEW
ALTER TABLE transactions ADD COLUMN match_status TEXT;                          -- matched (this row is a corroborating copy) | potential (needs review)
ALTER TABLE transactions ADD COLUMN match_method TEXT;                          -- upi_id | heuristic | user
ALTER TABLE transactions ADD COLUMN match_confidence REAL;
ALTER TABLE transactions ADD COLUMN match_candidate_id TEXT;                    -- the row this one matched / might match
UPDATE transactions SET event_id = id WHERE event_id IS NULL;
CREATE INDEX idx_txn_event ON transactions(user_id, event_id);
CREATE INDEX idx_txn_primary ON transactions(user_id, is_primary, txn_date);
CREATE INDEX idx_txn_upi_ref ON transactions(user_id, upi_reference);
ALTER TABLE statements ADD COLUMN provider_summary_json TEXT;                   -- e.g. Google Pay's Sent / Received totals
`,
  },
];
