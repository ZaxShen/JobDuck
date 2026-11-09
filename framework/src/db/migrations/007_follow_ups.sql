ALTER TABLE application_events ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('thank_you_sent', 'follow_up_sent'));
ALTER TABLE application_events ADD COLUMN round_id INTEGER REFERENCES application_events (id) ON DELETE CASCADE;

CREATE INDEX application_events_round ON application_events (round_id);
