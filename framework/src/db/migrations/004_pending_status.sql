-- jobduck:foreign_keys=off
CREATE TABLE applications_new (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings (id),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'applied', 'interviewing', 'offered',
    'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'
  )),
  pending_reason TEXT,
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
  deleted_at TEXT,
  salary_min INTEGER CHECK (salary_min IS NULL OR salary_min >= 0),
  salary_max INTEGER CHECK (salary_max IS NULL OR salary_max >= 0),
  salary_offered INTEGER CHECK (salary_offered IS NULL OR salary_offered >= 0),
  rsu INTEGER CHECK (rsu IS NULL OR rsu >= 0),
  options INTEGER CHECK (options IS NULL OR options >= 0),
  bonus INTEGER CHECK (bonus IS NULL OR bonus >= 0),
  sign_on INTEGER CHECK (sign_on IS NULL OR sign_on >= 0),
  relocation_fee INTEGER CHECK (relocation_fee IS NULL OR relocation_fee >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  country_override TEXT CHECK (country_override IS NULL OR country_override GLOB '[A-Z][A-Z]'),
  state_override TEXT,
  city_override TEXT,
  CHECK (status <> 'pending' OR pending_reason IS NOT NULL)
);

INSERT INTO applications_new (
  id, posting_id, status, pending_reason, applied_at, closed_at, closed_by, note, extracted,
  title_override, company_override, location_override, created_at, updated_at, deleted_at,
  salary_min, salary_max, salary_offered, rsu, options, bonus, sign_on, relocation_fee,
  currency, country_override, state_override, city_override
)
SELECT
  id, posting_id,
  CASE WHEN status IN (
    'applied', 'interviewing', 'offered', 'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'
  ) THEN status ELSE 'pending' END,
  CASE WHEN status IN (
    'applied', 'interviewing', 'offered', 'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'
  ) THEN NULL ELSE 'Saved before submitting; check whether it was sent.' END,
  applied_at, closed_at, closed_by, note, extracted,
  title_override, company_override, location_override, created_at, updated_at, deleted_at,
  salary_min, salary_max, salary_offered, rsu, options, bonus, sign_on, relocation_fee,
  currency, country_override, state_override, city_override
FROM applications;

DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;

CREATE UNIQUE INDEX applications_live_posting ON applications (posting_id) WHERE deleted_at IS NULL;
CREATE INDEX applications_status ON applications (status);

UPDATE application_events SET from_status = 'pending' WHERE from_status NOT IN (
  'applied', 'interviewing', 'offered', 'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'
);
UPDATE application_events SET to_status = 'pending' WHERE to_status NOT IN (
  'applied', 'interviewing', 'offered', 'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'
);
