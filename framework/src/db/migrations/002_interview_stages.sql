ALTER TABLE application_events ADD COLUMN stage_type TEXT CHECK (stage_type IS NULL OR stage_type IN (
  'information', 'phone_screen', 'online_assessment', 'hiring_manager', 'technical',
  'behavioral', 'system_design', 'onsite', 'take_home', 'other',
  'verbal', 'written'
));
ALTER TABLE application_events ADD COLUMN scheduled_at TEXT;
ALTER TABLE application_events ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN (
  'pending', 'advanced', 'rejected', 'ghosted', 'cancelled'
));

CREATE INDEX application_events_scheduled ON application_events (application_id, scheduled_at);

ALTER TABLE applications ADD COLUMN salary_min INTEGER CHECK (salary_min IS NULL OR salary_min >= 0);
ALTER TABLE applications ADD COLUMN salary_max INTEGER CHECK (salary_max IS NULL OR salary_max >= 0);
ALTER TABLE applications ADD COLUMN salary_offered INTEGER CHECK (salary_offered IS NULL OR salary_offered >= 0);
ALTER TABLE applications ADD COLUMN rsu INTEGER CHECK (rsu IS NULL OR rsu >= 0);
ALTER TABLE applications ADD COLUMN options INTEGER CHECK (options IS NULL OR options >= 0);
ALTER TABLE applications ADD COLUMN bonus INTEGER CHECK (bonus IS NULL OR bonus >= 0);
ALTER TABLE applications ADD COLUMN sign_on INTEGER CHECK (sign_on IS NULL OR sign_on >= 0);
ALTER TABLE applications ADD COLUMN relocation_fee INTEGER CHECK (relocation_fee IS NULL OR relocation_fee >= 0);
ALTER TABLE applications ADD COLUMN currency TEXT CHECK (currency IS NULL OR length(currency) = 3);
ALTER TABLE applications ADD COLUMN country_override TEXT CHECK (country_override IS NULL OR country_override GLOB '[A-Z][A-Z]');
ALTER TABLE applications ADD COLUMN state_override TEXT;
ALTER TABLE applications ADD COLUMN city_override TEXT;
