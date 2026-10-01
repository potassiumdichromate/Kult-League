-- Pixel Agency: players, agencies, staff, credits, analyses, predictions.
-- Points are stored ×10 (integers): an off-by-one goals pick is worth 3.5 points.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION pixel_agency.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

-- An AI Arena user. Agents are a snapshot from the AI Arena gateway, refreshed on every session.
CREATE TABLE pixel_agency.players (
  user_id          text PRIMARY KEY,
  wallet_address   text,
  username         text,
  agents           jsonb NOT NULL DEFAULT '[]',
  agents_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pixel_agency.agencies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  text NOT NULL UNIQUE REFERENCES pixel_agency.players(user_id),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 32),
  ceo_agent_id   text NOT NULL,
  ceo_name       text NOT NULL,
  ceo_clan       text,
  credits        bigint NOT NULL CHECK (credits >= 0),
  -- ISO week (e.g. 2026-W40) whose payroll has been settled; the first week is free.
  payroll_week   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agencies_name_ci ON pixel_agency.agencies (lower(name));

-- Every credit movement. The agency balance always equals the last balance_after.
CREATE TABLE pixel_agency.credit_ledger (
  id             bigserial PRIMARY KEY,
  agency_id      uuid NOT NULL REFERENCES pixel_agency.agencies(id),
  delta          bigint NOT NULL,
  balance_after  bigint NOT NULL CHECK (balance_after >= 0),
  kind           text NOT NULL CHECK (kind IN ('grant', 'hire', 'salary', 'winnings')),
  ref            text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, kind, ref)
);
CREATE INDEX credit_ledger_agency ON pixel_agency.credit_ledger (agency_id, id DESC);
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON pixel_agency.credit_ledger
  FOR EACH ROW EXECUTE FUNCTION pixel_agency.reject_change();

CREATE TABLE pixel_agency.analysts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      uuid NOT NULL REFERENCES pixel_agency.agencies(id),
  -- Talent-pool candidate (week:index); a candidate can be hired once per agency.
  candidate_key  text NOT NULL,
  name           text NOT NULL,
  specialty      text NOT NULL CHECK (specialty IN ('form', 'lineups', 'weather', 'odds', 'set_pieces', 'discipline', 'scorers')),
  skill          smallint NOT NULL CHECK (skill BETWEEN 1 AND 5),
  xp             integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  hire_cost      integer NOT NULL CHECK (hire_cost > 0),
  weekly_salary  integer NOT NULL CHECK (weekly_salary > 0),
  style          text NOT NULL,
  hired_at       timestamptz NOT NULL DEFAULT now(),
  fired_at       timestamptz,
  fire_reason    text CHECK (fire_reason IN ('fired', 'unpaid')),
  UNIQUE (agency_id, candidate_key),
  CHECK ((fired_at IS NULL) = (fire_reason IS NULL))
);
CREATE INDEX analysts_active ON pixel_agency.analysts (agency_id) WHERE fired_at IS NULL;

-- One row per analysis run: what each analyst read and recommended, and the CEO's combination.
CREATE TABLE pixel_agency.analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL REFERENCES pixel_agency.agencies(id),
  fixture_id  bigint NOT NULL,
  reports     jsonb NOT NULL,
  combined    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analyses_agency_fixture ON pixel_agency.analyses (agency_id, fixture_id, created_at DESC);
CREATE TRIGGER analyses_append_only BEFORE UPDATE OR DELETE ON pixel_agency.analyses
  FOR EACH ROW EXECUTE FUNCTION pixel_agency.reject_change();

CREATE TABLE pixel_agency.predictions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL REFERENCES pixel_agency.agencies(id),
  fixture_id   bigint NOT NULL,
  league_name  text NOT NULL,
  home_team    text NOT NULL,
  away_team    text NOT NULL,
  kickoff_at   timestamptz NOT NULL,
  lock_at      timestamptz NOT NULL,
  -- ISO week of kickoff (UTC): the weekly leaderboard bucket.
  week         text NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'LOCKED', 'SETTLED', 'VOID')),
  picks        jsonb NOT NULL,
  analysis_id  uuid REFERENCES pixel_agency.analyses(id),
  edited       boolean NOT NULL DEFAULT false,
  locked_at    timestamptz,
  auto_locked  boolean NOT NULL DEFAULT false,
  settled_at   timestamptz,
  points_x10   integer NOT NULL DEFAULT 0 CHECK (points_x10 >= 0),
  exact_hits   integer NOT NULL DEFAULT 0 CHECK (exact_hits >= 0),
  breakdown    jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, fixture_id)
);
CREATE INDEX predictions_to_lock ON pixel_agency.predictions (lock_at) WHERE status = 'DRAFT';
CREATE INDEX predictions_to_settle ON pixel_agency.predictions (kickoff_at) WHERE status = 'LOCKED';
CREATE INDEX predictions_week ON pixel_agency.predictions (week) WHERE status = 'SETTLED';
CREATE INDEX predictions_settled ON pixel_agency.predictions (agency_id) WHERE status = 'SETTLED';

-- Picks are frozen once locked; a settled or void prediction is final.
CREATE OR REPLACE FUNCTION pixel_agency.guard_prediction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'predictions cannot be deleted';
  END IF;
  IF OLD.status IN ('SETTLED', 'VOID') THEN
    RAISE EXCEPTION 'prediction % is final', OLD.id;
  END IF;
  IF OLD.status = 'LOCKED' AND (NEW.picks IS DISTINCT FROM OLD.picks OR NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'prediction % is locked', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER predictions_guard BEFORE UPDATE OR DELETE ON pixel_agency.predictions
  FOR EACH ROW EXECUTE FUNCTION pixel_agency.guard_prediction();
