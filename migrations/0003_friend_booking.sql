ALTER TABLE participants ADD COLUMN booking_user_id TEXT;
CREATE UNIQUE INDEX participants_booking_user ON participants(booking_user_id)
  WHERE booking_user_id IS NOT NULL;

ALTER TABLE bookings ADD COLUMN line_display_name TEXT;
ALTER TABLE bookings ADD COLUMN display_name TEXT;
ALTER TABLE bookings ADD COLUMN name_updated_at INTEGER;
CREATE INDEX bookings_by_user ON bookings(user_id, state);
