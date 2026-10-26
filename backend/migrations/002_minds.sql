-- A Hello Minds agent ("Mind") can direct an agency (docs/ARCHITECTURE.md, "Mind directors").
-- The owner links their Minds account; the Mind calls the director API with a director key.

CREATE TABLE pixel_agency.agency_minds (
  agency_id      uuid PRIMARY KEY REFERENCES pixel_agency.agencies(id),
  -- The Minds account (OAuth `sub`), proven against the Minds API at link time.
  minds_user_id  text NOT NULL UNIQUE,
  -- The Mind that directs the agency; null until the owner picks one (when the account has several).
  mind_id        text,
  mind_name      text,
  mind_email     text,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Keys the Mind's Skill sends as X-Director-Key. Only the SHA-256 is stored.
CREATE TABLE pixel_agency.director_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES pixel_agency.agencies(id),
  key_hash      text NOT NULL UNIQUE,
  prefix        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX director_keys_active ON pixel_agency.director_keys (agency_id) WHERE revoked_at IS NULL;

-- Who made the final call, and the Mind's entry on the ai-infrastructure record.
-- record: { status: pending | recorded | rejected | missed, agentId, conviction, rationale, evidence, decisionId?, error? }
ALTER TABLE pixel_agency.predictions
  ADD COLUMN decided_by text NOT NULL DEFAULT 'ceo' CHECK (decided_by IN ('ceo', 'mind')),
  ADD COLUMN mind_id    text,
  ADD COLUMN record     jsonb,
  ADD CONSTRAINT predictions_mind_decision CHECK ((decided_by = 'mind') = (mind_id IS NOT NULL AND record IS NOT NULL));
CREATE INDEX predictions_record_pending ON pixel_agency.predictions (kickoff_at) WHERE decided_by = 'mind' AND record ->> 'status' = 'pending';
