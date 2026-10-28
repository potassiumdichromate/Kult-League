# Pixel Agency backend

Pixel Agency is an HTML5 game in which each player runs a football analysis agency. The CEO is one of the player's own AI Arena agents. The CEO hires analysts, each with a specialty. Analysts research a match in their own context: form, team news, weather, betting markets, set pieces, discipline or scorers. Each analyst recommends picks, the desk combines them into a draft, the CEO edits it and then locks the picks before kickoff. Settled picks earn points, which feed two global leaderboards (weekly and all-time) and pay out credits for hiring.

This service is the game's backend. It owns players, agencies, staff, credits, analyses, predictions, scoring and leaderboards. Match intelligence (fixtures, the 0G forecast, research briefs and results) comes from **ai-infrastructure**. Identity comes from **AI Arena**.

## Contents

1. [System context](#system-context)
2. [Sign-in](#sign-in)
3. [Agency, staff and credits](#agency-staff-and-credits)
4. [Match analysis](#match-analysis)
5. [Predictions and locking](#predictions-and-locking)
6. [Scoring](#scoring)
7. [Leaderboards](#leaderboards)
8. [Background worker](#background-worker)
9. [Data model](#data-model)
10. [Security](#security)
11. [API reference](#api-reference)
12. [Configuration and deployment](#configuration-and-deployment)
13. [Testing](#testing)
14. [Mind directors](#mind-directors)

---

## System context

```
 Kult browser ──(AI Arena token)──▶ Pixel Agency game (HTML5)
                                         │  bearer session token
                                         ▼
                              Pixel Agency backend ──────▶ Postgres (schema pixel_agency)
                               │                  │
          GET /v1/auth/me,     │                  │  HMAC-signed (key: pixel-agency)
          /v1/agents/mine      ▼                  ▼
                     AI Arena gateway       ai-infrastructure ──▶ 0G Compute, 0G Storage, 0G Chain
                                             (fixtures, forecast, research, outcome)
```

- **AI Arena** answers who the player is and which agents they own. The backend never sees AI Arena's signing secret; it forwards the player's token to the gateway.
- **ai-infrastructure** answers everything about the match. It builds one forecast per fixture on 0G Compute, keeps research briefs per specialty and settles results. Prediction bundles are anchored on 0G Chain.

## Sign-in

1. The game loads inside the Kult browser with the player's AI Arena token.
2. `POST /v1/auth/session {aiArenaToken}`: the backend calls the AI Arena gateway (`/v1/auth/me`, `/v1/agents/mine`) with that token. It stores the player and a snapshot of their agents, then issues the game's own session token: an HS256 JWT, 12 hours by default.
3. Every other call carries `Authorization: Bearer <session token>`. Agent ownership is checked against the snapshot, which is refreshed on every sign-in.

## Agency, staff and credits

| Rule | Value |
|---|---|
| Founding credits | 1,500 |
| CEO | One of the player's own AI Arena agents (not retired); can be changed |
| Desks | 3 at level 1, one more per level, at most 7 |
| Agency level | By all-time points: 0 / 50 / 150 / 300 / 500 → levels 1–5 |
| Talent pool | 10 candidates per agency per ISO week, every specialty at least once, refreshed Monday 00:00 UTC |
| Hire cost by skill 1–5 | about 80 / 150 / 260 / 420 / 650 (±10% per candidate) |
| Weekly salary by skill 1–5 | 20 / 40 / 70 / 110 / 160 |
| Payroll | Once per ISO week (the founding week is free). Analysts are paid in hiring order; anyone the agency can't afford quits. |
| Winnings | 1 credit per 0.1 point (52 points = 520 credits) |
| Analyst growth | +10 XP per settled match worked, plus a share of the points in their markets. Skill rises at `skill × 100` XP, and the salary rises with it. |

The talent pool is generated from (agency, week), so it needs no storage and can't be rerolled. Every credit movement is a row in the append-only `credit_ledger`, unique per (agency, kind, ref). Payroll and winnings are therefore idempotent.

| Specialty | Title | Advises on | Reads |
|---|---|---|---|
| `form` | Form Analyst | outcome, score | Last 5 results and head-to-head: tilts the result by points per game; blends goals scored |
| `lineups` | Team News Scout | outcome, scorer | Absences per side: shifts the result toward the fuller squad |
| `weather` | Weather & Pitch Analyst | score, corners | Kickoff-hour conditions: rain, snow or strong wind lowers goals; wind adds corners |
| `odds` | Market Analyst | outcome, score | Margin-free bookmaker prices replace the model's result probabilities; the over-2.5 price moves goals |
| `set_pieces` | Set-Piece Coach | corners | Recent corner averages blended with the expected total |
| `discipline` | Discipline Analyst | cards | Recent card averages blended with the expected total |
| `scorers` | Striker Scout | scorer | Anytime-scorer chances by player |

## Match analysis

`POST /v1/fixtures/:id/analysis`

1. Fetch the fixture context. If no forecast exists yet and the window is open, ask ai-infrastructure to build it (`POST /fixtures/:id/forecast`). Only one forecast is ever built per fixture.
2. Fetch one research brief per hired specialty, in parallel. A failed brief doesn't fail the analysis: that analyst works without data.
3. **Analyst reports.** Each analyst views the shared 0G forecast through their own brief (see the table above) and recommends picks for their markets:
   - Skill sets how often they read their signal cleanly: 55% at skill 1 up to 95% at skill 5, and 15 points lower without data. Otherwise they take a plausible but less likely view.
   - Corners and cards add noise that shrinks with skill.
   - The score always agrees with the outcome the analyst picked.
   - Reads are seeded by (analyst, fixture), so re-running an analysis with the same staff gives the same reports. There is nothing to farm.
4. **CEO combination.** The CEO combines the recommendations market by market:
   - Outcome, score and scorer: skill-weighted vote. Ties go to the forecast's more likely option, and only scores that agree with the combined outcome count.
   - Corners and cards: skill-weighted mean.
   - Markets nobody covers get the CEO's gut call, a skill-1 read. The response flags these as `source: "ceo"`.
5. Store the analysis (append-only) and save the result as the draft prediction.

An agency can analyse each fixture up to `MAX_ANALYSES_PER_FIXTURE` times (default 3). Re-running after hiring someone replaces the draft.

## Predictions and locking

| Market | Pick | Validation |
|---|---|---|
| Outcome | HOME / DRAW / AWAY | Must agree with the exact score |
| Goals | Exact final score | 0–15 each side |
| Corners | Total | 0–30 |
| Cards | Total | 0–20 |
| Goal scorer | Player id | Must be in either squad (or none) |

- `PUT /v1/fixtures/:id/prediction` lets the CEO edit any subset of the draft. The merged picks are validated as a whole.
- `POST /v1/fixtures/:id/prediction/lock` locks the picks early.
- At `kickoff − LOCK_MINUTES_BEFORE_KICKOFF` (default 5 minutes) the worker locks every remaining draft as it stands.
- The database enforces this. Locked picks can't change, settled or void predictions are final, and predictions can't be deleted.
- A postponed match keeps its picks and moves to its new kickoff time and week.

## Scoring

All points are measured on regulation time. Values are stored ×10 as integers.

| Market | Exact | Off by one | Otherwise |
|---|---|---|---|
| Outcome | 5 | — | 0 |
| Goals (exact score) | 7 | 3.5 when the total goal distance `|h−H| + |a−A|` is 1 | 0 |
| Corners | 10 | 5 | 0 |
| Cards | 10 | 5 | 0 |
| Goal scorer (anytime, own goals excluded) | 20 | — | 0 |

The maximum is 52 points per match. A cancelled or abandoned match voids the prediction. A market whose result data is missing voids that market only.

## Leaderboards

`GET /v1/leaderboards/weekly?week=2026-W40` and `GET /v1/leaderboards/all-time` are public.

- Rank by points, then by exact hits.
- The weekly bucket is the ISO week (UTC) of kickoff.
- A signed-in caller also gets their own standing as `me`.

## Background worker

`node dist/worker.js` runs these jobs every `WORKER_INTERVAL_SECONDS`. Each job is idempotent:

1. **Auto-lock** drafts whose lock time has passed.
2. **Settle** locked predictions once ai-infrastructure has the result:
   - It starts looking 115 minutes after kickoff.
   - Each settlement transaction scores the picks, pays winnings into the ledger and awards analyst XP.
3. **Payroll**, once per agency per ISO week.

## Data model

All tables live in the `pixel_agency` schema (`migrations/001_init.sql`).

| Table | Holds | Integrity |
|---|---|---|
| `players` | AI Arena user, agent snapshot | — |
| `agencies` | Name (unique, case-insensitive), CEO, credits, payroll week | `credits ≥ 0`, one per player |
| `credit_ledger` | Every credit movement with the balance after it | Append-only; unique (agency, kind, ref) |
| `analysts` | Staff, skill, XP, salary, fired/quit | A candidate can be hired once per agency |
| `analyses` | Reports and the CEO's combination per run | Append-only |
| `predictions` | Picks, lock state, settlement, breakdown | Lock/final guard trigger; no deletes |

## Security

- **Authentication**:
  - The AI Arena gateway is the only authority on identity.
  - Game sessions are HS256 tokens with a fixed algorithm, issuer and expiry, compared in constant time.
  - There is no fallback secret: the service refuses to start without `SESSION_SECRET`.
- **Authorization**:
  - Every route acts on the caller's own agency only. There are no ids to tamper with except fixtures and the caller's own analysts.
  - The CEO must be one of the caller's own agents.
- **Upstream calls**:
  - ai-infrastructure is called with an HMAC-signed service key scoped to `football:read` and `football:predict`.
  - Only 400/404/409 messages are passed through; anything else becomes a generic 503.
- **CORS**: explicit origin allowlist (https in production, no wildcard). Credentials are off; auth is a bearer header.
- **Abuse limits**:
  - Per-IP rate limits overall, tighter on sign-in (20/min) and analysis (10/min).
  - Analysis runs per fixture are capped.
  - The proxy trust is exactly one hop.
- **Errors**: only `AppError` messages reach clients. Internals, SQL and upstream details are logged, never returned. Logs redact authorization headers and secrets.
- **Money-like state**: all credit changes happen in transactions that hold the agency row lock and write the ledger. The database rejects negative balances, and ledger edits are blocked.

## API reference

All `/v1` routes except sign-in and leaderboards need `Authorization: Bearer <session token>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/session` | `{aiArenaToken}` → `{token, expiresAt, player, agents, agency}` |
| GET | `/v1/me` | Player, agents, agency |
| POST | `/v1/agency` | `{name, ceoAgentId}`: found the agency |
| GET | `/v1/agency` | Credits, level, desks, staff, payroll, standings |
| PUT | `/v1/agency/ceo` | `{ceoAgentId}`: change CEO |
| GET | `/v1/agency/ledger` | Last 100 credit movements |
| GET | `/v1/talent` | This week's candidates |
| POST | `/v1/staff` | `{candidateKey}`: hire |
| DELETE | `/v1/staff/:analystId` | Fire |
| GET | `/v1/fixtures?from&to&league` | Upcoming fixtures with lock time and your prediction status |
| GET | `/v1/fixtures/:id` | Fixture, squads, absences, your prediction and its analysis |
| POST | `/v1/fixtures/:id/analysis` | Run the desk analysis → reports, combined picks, draft |
| PUT | `/v1/fixtures/:id/prediction` | Edit the draft (any of outcome, score, corners, cards, scorerId) |
| POST | `/v1/fixtures/:id/prediction/lock` | Lock now |
| GET | `/v1/predictions` | Your last 50 predictions with results |
| GET | `/v1/leaderboards/:kind` | `weekly` (`?week=`) or `all-time`; `?limit&offset` |
| GET | `/health`, `/ready` | Liveness, and readiness (database) |

**Mind directors** ([Mind directors](#mind-directors)). Owner routes need the game session; director routes need `X-Director-Key`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/agency/mind` | `{accessToken, mindId?}`: link a Minds account, choose the Mind → `{mind, minds, key}` (key once) |
| GET | `/v1/agency/mind` | The linked Mind and director keys (prefixes only) |
| DELETE | `/v1/agency/mind` | Unlink; revokes every key |
| POST | `/v1/agency/mind/keys` | New director key (shown once) |
| DELETE | `/v1/agency/mind/keys/:keyId` | Revoke a key |
| GET | `/v1/director/openapi.json` | Public: the spec the Mind builds its Skill from |
| GET | `/v1/director/record` | The Mind's career record and the agency's standing |
| GET | `/v1/director/agency`, `/talent`, `/fixtures`, `/fixtures/:id`, `/predictions` | As the owner's routes |
| POST, DELETE | `/v1/director/staff`, `/v1/director/staff/:analystId` | Hire, fire |
| POST | `/v1/director/fixtures/:id/analysis` | Run the desk analysis |
| POST | `/v1/director/fixtures/:id/decision` | `{picks, conviction, rationale, evidence}`: the final call, locked and put on the record |

Errors are returned as `{error, message?, correlationId}`. The status codes are:

- 400 invalid input
- 401 sign in
- 402 not enough credits
- 403 not your agent
- 404
- 409 closed, locked or conflicting
- 429 limit reached
- 503 upstream unavailable

## Mind directors

A player can hand the final call to their **Hello Minds** agent (a "Mind", by Animoca Brands). The Mind directs the agency through its own API: it reads the analysts' reports, hires and fires, does its own research, and decides each match. Every decision it makes also goes on a career record in ai-infrastructure, anchored on 0G Chain before kickoff, graded after the match, and compared with the 0G baseline on the same matches. The record follows the Mind across agencies and seasons.

**Linking (owner, game session).**
1. The game signs the owner in with Minds Connect (OAuth + PKCE, scopes `email minds:list`).
2. `POST /v1/agency/mind {accessToken, mindId?}` proves the token by listing the owner's Minds on Hello Minds (`GET /v1/users/{sub}/minds`). It links the Minds account to the agency, picks the directing Mind (the one named, or the account's only Mind) and, when the agency has none, issues a **director key**. The key is shown once; only its SHA-256 is stored. At most 3 are active.
3. One Minds account directs one agency. Unlinking revokes every key.

**One KULT key.** A Mind linked to an AI Arena agent holds one key for every KULT product (`kult_mk_…`, 0g-AIArena docs/minds/AGENT_MINDS.md). The director API accepts it as `X-Mind-Key` in place of a director key: it asks AI Arena whose key it is (`/v1/marketplace/mind/me`, cached for a minute) and directs the agency whose owner owns that agent and whose CEO it is. Kult Sports makes that link when the player links their Mind, if their AI Arena login is fresh.

**Directing (the Mind's Skill, `X-Director-Key`).** The owner gives their Mind `GET /v1/director/openapi.json`; following Minds' Skill guide, the Mind builds a Skill from it. The spec's description is written for the Mind: a daily routine, the scoring, and how the record works.

**A Mind's decision** (`POST /v1/director/fixtures/:id/decision`) is final the moment it is made:

| Step | Rule |
|---|---|
| Open | The match hasn't started, it is before the game's lock time, **and** the record is still open (ai-infrastructure locks 30 minutes before kickoff by default). Otherwise `409` and nothing changes. |
| Valid | Outcome agrees with the score; the scorer is in a squad and plays for a side the score says will score. Every problem is listed in one `400`. |
| Lock | The prediction is created or the open draft taken over (its analysis kept, so the analysts still earn XP) and locked in one statement, `decided_by = 'mind'`. |
| Record | Submitted to ai-infrastructure as `mind:<mindId>` (`POST /v1/football/fixtures/:id/submissions`, scope `football:submit`). Exact cards and corners go on the record as over/under 4.5 and 9.5. The record status becomes `recorded`, or `rejected` / `missed` with the reason. If the record is briefly unreachable the status stays `pending` and the worker submits it on its next run. The record is write-once, so a retry can never change it. |

**What the Mind sees.** Its analysts' reports, squads, absences and its own research. It does not get the raw 0G forecast: that is what the analysts read, and handing it over would make hiring pointless. The forecast is used only after the fact, as the baseline on the record.

A match the Mind doesn't decide plays out as before: the desk's draft locks as it stands, as a CEO pick, and doesn't count on the Mind's record.

`GET /v1/director/record` returns the career from ai-infrastructure (per market with confidence intervals, conviction calibration, paired comparison with the 0G baseline, lessons) with this agency's standing.

---

## Configuration and deployment

See `.env.example`. You need:

- `DATABASE_URL`
- `SESSION_SECRET`
- `AI_ARENA_API_URL`
- `AI_INFRA_URL`, `AI_INFRA_KEY_ID` and `AI_INFRA_SECRET`
- `CORS_ORIGINS`

**ai-infrastructure side:**

1. Generate a key with `pnpm keygen` in ai-infrastructure.
2. Add `{"id":"pixel-agency","secret":"…","scopes":["football:read","football:predict"]}` to its `SERVICE_KEYS`.
3. Put the same id and secret here.

**Render:** `render.yaml` (at the repository root) defines:

- a public web service, with migrations as the pre-deploy step
- a worker
- a Postgres database

Syncing it creates billable resources. Put it in the same region as ai-infrastructure so it can reach `http://ai-infrastructure:10000` over the private network.

## Testing

```bash
pnpm test:unit
docker compose up -d
TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm test
```

- **Unit tests** cover scoring, pick validation, analyst reads and the CEO combination, ISO weeks, progression, the talent pool, session tokens, config, and both upstream clients (including the HMAC signature).
- **The integration test** drives the whole game over HTTP against Postgres:
  - sign-in, founding, hiring and firing, analysis, edits and locking
  - auto-lock, settlement with winnings and XP
  - leaderboards, payroll and quitting
  - CORS and database guards
