CREATE TABLE IF NOT EXISTS booking_names (
  line_user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  created_at INTEGER NOT NULL
);
