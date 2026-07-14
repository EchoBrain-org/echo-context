CREATE TABLE events (
  id        TEXT PRIMARY KEY,
  source    TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  content   TEXT NOT NULL,
  metadata  TEXT,
  embedding BLOB
);
CREATE INDEX idx_events_source    ON events(source);
CREATE INDEX idx_events_timestamp ON events(timestamp);
