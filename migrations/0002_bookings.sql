CREATE TABLE IF NOT EXISTS case_choices (
  case_id TEXT PRIMARY KEY REFERENCES cases(id),
  user_id TEXT NOT NULL,
  choice_index INTEGER NOT NULL CHECK (choice_index BETWEEN 0 AND 2),
  chosen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  participant_key TEXT NOT NULL REFERENCES participants(key),
  user_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  options TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('offered', 'applying', 'booked', 'review', 'closed')),
  reason TEXT,
  choice_index INTEGER,
  chosen_at INTEGER,
  target_start INTEGER,
  target_end INTEGER,
  apply_after INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  transition_tag TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_open ON bookings(participant_key)
  WHERE state IN ('offered', 'applying');
CREATE INDEX IF NOT EXISTS bookings_queue ON bookings(state, apply_after, lease_until);
CREATE INDEX IF NOT EXISTS bookings_slots ON bookings(state, target_start, target_end);
