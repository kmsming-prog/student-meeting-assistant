CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  key TEXT PRIMARY KEY,
  line_user_id TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  last_line_at INTEGER NOT NULL DEFAULT 0,
  invite_hash TEXT UNIQUE,
  invite_deadline INTEGER
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS receipts_seen ON webhook_receipts(seen_at);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  student_key TEXT NOT NULL REFERENCES participants(key),
  source_etag TEXT,
  original_start INTEGER NOT NULL,
  original_end INTEGER NOT NULL,
  options TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('offered', 'applying', 'moved', 'review', 'closed')),
  reason TEXT,
  target_start INTEGER,
  target_end INTEGER,
  chosen_user_id TEXT,
  apply_after INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  transition_tag TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(calendar_id, event_id),
  UNIQUE(calendar_id, series_id, original_start)
);

CREATE INDEX IF NOT EXISTS cases_queue ON cases(state, apply_after, deadline);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  case_id TEXT REFERENCES cases(id),
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL REFERENCES participants(key),
  message TEXT NOT NULL,
  retry_key TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  first_attempt_at INTEGER,
  destination TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS outbox_queue ON outbox(state, next_at, lease_until);
CREATE INDEX IF NOT EXISTS outbox_month ON outbox(first_attempt_at);

CREATE TABLE IF NOT EXISTS line_tests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  case_id TEXT,
  detail TEXT
);
