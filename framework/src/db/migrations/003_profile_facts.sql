CREATE TABLE profile_facts (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE,
  company TEXT,
  role TEXT,
  project TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'skill', 'tool', 'action', 'outcome', 'methodology', 'context', 'challenge', 'domain-knowledge', 'leadership'
  )),
  action TEXT NOT NULL,
  outcome TEXT,
  metrics TEXT,
  skills TEXT CHECK (skills IS NULL OR (json_valid(skills) AND json_type(skills) = 'array')),
  tools TEXT CHECK (tools IS NULL OR (json_valid(tools) AND json_type(tools) = 'array')),
  basis TEXT NOT NULL CHECK (basis IN ('stated', 'inferred')),
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX profile_facts_status ON profile_facts (status, company, project);
