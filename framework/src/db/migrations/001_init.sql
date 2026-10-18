CREATE TABLE postings (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('freehire', 'manual', 'agent')),
  source_id TEXT,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  country TEXT,
  state TEXT,
  city TEXT,
  work_mode TEXT,
  job_type TEXT,
  posted_at TEXT,
  pay_min REAL,
  pay_max REAL,
  pay_period TEXT,
  currency TEXT,
  description TEXT,
  raw TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings (id),
  status TEXT NOT NULL CHECK (status IN (
    'saved', 'applied', 'interviewing', 'offered',
    'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'
  )),
  applied_at TEXT,
  closed_at TEXT,
  closed_by TEXT,
  note TEXT,
  extracted TEXT CHECK (extracted IS NULL OR json_valid(extracted)),
  title_override TEXT,
  company_override TEXT,
  location_override TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX applications_live_posting ON applications (posting_id) WHERE deleted_at IS NULL;
CREATE INDEX applications_status ON applications (status);

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL CHECK (source IN ('agent', 'dashboard', 'sync', 'user')),
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at TEXT NOT NULL
);

CREATE INDEX application_events_application ON application_events (application_id);

CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('rejection')),
  company TEXT,
  title TEXT,
  job_url TEXT,
  job_ref TEXT,
  received_at TEXT NOT NULL,
  application_id INTEGER REFERENCES applications (id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'matched', 'needs_match', 'dismissed')),
  matched_by TEXT,
  candidates TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
