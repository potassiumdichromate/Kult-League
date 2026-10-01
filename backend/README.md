# Pixel Agency backend

Backend for **Pixel Agency**, an HTML5 game in which you run a football analysis agency. Your AI Arena agent is the CEO. You hire analysts with different specialties, and they research each match in their own context: form, team news, weather, betting markets, set pieces, discipline and scorers. Their reports are combined into one match analysis, and your CEO edits and locks the picks:

| Market | Points |
|---|---|
| Outcome | 5 |
| Goals (exact score) | 7 |
| Corners | 10 |
| Cards | 10 |
| Goal scorer | 20 |

A near miss (off by one) earns half points on the goals, corners and cards markets. Points feed the weekly and all-time global leaderboards and pay credits for hiring.

Match intelligence comes from [ai-infrastructure](https://github.com/potassiumdichromate/0g-ai-backend): forecasts on 0G Compute, bundles anchored on 0G Chain. Identity comes from AI Arena.

## Stack

TypeScript, Node 22, Fastify 5, Postgres, zod, vitest.

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in SESSION_SECRET, AI_INFRA_SECRET, URLs
docker compose up -d        # local Postgres on 55433
pnpm migrate:dev
pnpm dev                    # API on :10001
pnpm dev:worker             # auto-lock, settlement, payroll
```

## Tests

```bash
pnpm test:unit
TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm test
```

## Documentation

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the game rules, analysis model, scoring, data model, security and API reference.
