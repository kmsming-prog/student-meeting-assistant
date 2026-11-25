CREATE TABLE IF NOT EXISTS meeting_conflicts (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  series_id TEXT,
  booking_id TEXT REFERENCES bookings(id),
  participant_key TEXT NOT NULL REFERENCES participants(key),
  name TEXT NOT NULL,
  original_start INTEGER NOT NULL,
  original_end INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'review', 'resolved', 'cleared')),
  reason TEXT NOT NULL,
  target_start INTEGER,
  target_end INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((series_id IS NULL) <> (booking_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_conflicts_active ON meeting_conflicts(calendar_id,event_id)
  WHERE state IN ('pending','review');

ALTER TABLE bookings ADD COLUMN reschedule_id TEXT REFERENCES meeting_conflicts(id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_conflict_applying ON bookings(reschedule_id)
  WHERE reschedule_id IS NOT NULL AND state='applying';

ALTER TABLE outbox ADD COLUMN conflict_id TEXT REFERENCES meeting_conflicts(id);
CREATE INDEX IF NOT EXISTS outbox_conflict ON outbox(conflict_id,state);

CREATE TABLE IF NOT EXISTS calendar_watches (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  resource_id TEXT,
  expires_at INTEGER NOT NULL,
  sync_at INTEGER,
  last_signal_at INTEGER
);

CREATE TABLE IF NOT EXISTS calendar_monitor (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  requested INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_scan INTEGER,
  last_error TEXT,
  watch_error TEXT
);
INSERT OR IGNORE INTO calendar_monitor(id) VALUES (1);
