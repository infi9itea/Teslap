# Dhaka Tesla Pool — API Scaffold

Working implementation of the design in `Dhaka_Tesla_Pool_Plan.md/.docx/.pdf` (the
full build plan — architecture, ERD, fare math, and the reasoning behind every
decision below lives there). This repo is the code that plan describes.

## What's implemented

- **Schema** (`api/prisma/schema.prisma`) — the full ERD: users, teslas, pools,
  ride_requests, fares, status_history, payments, idempotency_keys.
- **Detour-ratio matching** (`api/src/lib/geo.js`) — haversine distance, shortest
  pooled-route ordering, and the ≤1.3 detour-ratio rule from Section 5 of the plan.
- **Savings-based fare split** (`api/src/lib/fare.js`) — pool discount computed
  from actual distance saved, split proportionally, per Section 6.
- **Ride lifecycle state machine** (`api/src/lib/lifecycle.js`) — single source
  of truth for valid transitions, used by every route that changes ride status.
- **The concurrency-critical endpoint** (`api/src/routes/pools.js`) —
  `POST /pools/:id/claim`, using `SELECT ... FOR UPDATE` + `lock_timeout` +
  idempotency keys, exactly as designed in Section 7.
- **DB-level backstop** (`api/prisma/sql/enforce_capacity_trigger.sql`) — a
  trigger that makes an overbooked Tesla impossible even if application logic
  has a bug.
- **Tests** (`api/src/__tests__/`) — 15 unit tests (fare math, matching,
  lifecycle transitions) plus one integration test for the Nusrat-vs-Shirin
  race, gated behind a live `DATABASE_URL`.

## Verified, not just written

Every number in the plan's Section 6 worked example and every claim in
Section 7 about the concurrency fix was checked against running code before
being written down:

- The seed coordinates in `prisma/seed.js` are constructed so Nusrat's and
  Rafiq's direct distances are *exactly* 3.5km and 2.8km, and their pooled
  detour ratios (1.236 and 1.000) were computed by `geo.js` itself, not
  eyeballed.
- The fare split (Nusrat 4922 paisa, Rafiq 4538 paisa) comes directly from
  `fare.js` run against those coordinates — see `__tests__/fare.test.js`.
- The seat-claim race was run for real against a live Postgres (two
  transactions firing `Promise.all`, one artificially holding its lock for
  150ms) and resolved correctly: exactly one claim succeeded, `occupied_seats`
  never exceeded 1. The DB trigger was separately confirmed to reject a raw
  SQL attempt to set `occupied_seats = 2` directly, bypassing the app entirely.

One caveat from building this in a network-sandboxed environment: Prisma's
query-engine binary is fetched from `binaries.prisma.sh` at `npx prisma
generate` time, which wasn't reachable here — a sandbox limitation only (a
real deploy on Render/Railway/Fly has normal internet access, so `npm install`
there will generate the client without any changes). To still prove the
locking logic for real rather than just asserting it, the concurrency test
above was run through the raw `pg` driver, executing the identical SQL
`pools.js` runs through Prisma. `api/src/__tests__/concurrency.test.js` is
the Prisma-native version of that same test, ready to run once `prisma
generate` succeeds in a normal environment.

## Running it

```bash
cp .env.example .env          # fill in JWT_SECRET at minimum
docker compose up -d db
cd api
npm install
npx prisma migrate dev --name init
psql "$DATABASE_URL" -f prisma/sql/enforce_capacity_trigger.sql
npx prisma db seed
npm run dev                    # API on :4000
```

Run the unit tests any time (no DB needed):
```bash
cd api && npm test
```

Run the full suite including the concurrency integration test (needs the DB
from `docker compose up -d db`, migrated and seeded):
```bash
cd api && DATABASE_URL=postgresql://tesla:tesla_dev_password@localhost:5432/tesla_pool npm test
```

## Not yet built

Per the plan's lean-MVP scope: the Next.js frontend (`web/` is a placeholder),
and the bonus scaling items (Section 13) are deliberately design-only, not code
— they're the "what changes at scale" answer, not part of the MVP.
