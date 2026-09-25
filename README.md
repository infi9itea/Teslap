# Dhaka Tesla Pool: API + Frontend

Working implementation of the design in `Dhaka_Tesla_Pool_Plan.md/.docx/.pdf`
(the full build plan: architecture, ERD, fare math, and the reasoning behind
every decision below lives there). This repo is the code that plan
describes, and every core flow has been run end-to-end through the real
browser UI against a live Postgres, not just unit-tested in isolation.

## What's implemented

- **Schema** (`api/prisma/schema.prisma`): the full ERD, covering users,
  teslas, pools, ride_requests, fares, status_history, payments, and
  idempotency_keys.
- **Detour-ratio matching** (`api/src/lib/geo.js`): haversine distance,
  shortest pooled-route ordering, and the <=1.3 detour-ratio rule from
  Section 5 of the plan.
- **Savings-based fare split** (`api/src/lib/fare.js`): pool discount
  computed from actual distance saved, split proportionally, per Section 6.
- **Ride lifecycle state machine** (`api/src/lib/lifecycle.js`): single
  source of truth for valid transitions, used by every route that changes
  ride status.
- **Pool assignment** (`api/src/routes/rides.js`): `POST /rides` finds or
  creates a `FORMING` pool on an available online Tesla and assigns matched
  (or solo) requests to it, so there's always something real for the claim
  endpoint to claim into.
- **The concurrency-critical endpoint** (`api/src/routes/pools.js`):
  `POST /pools/:id/claim`, using `SELECT ... FOR UPDATE` plus `lock_timeout`
  plus idempotency keys, exactly as designed in Section 7.
- **DB-level backstop** (`api/prisma/sql/enforce_capacity_trigger.sql`): a
  trigger that makes an overbooked Tesla impossible even if application
  logic has a bug.
- **Driver lifecycle routes** (`api/src/routes/driver.js`): manifest view,
  plus arrive/start/complete transitions, each authorization-checked against
  the requesting driver's own Tesla.
- **Frontend** (`web/`): Next.js App Router app with login/register, a
  passenger ride-request flow, and a driver manifest with lifecycle action
  buttons.
- **CORS + env loading** (`api/src/app.js`, `api/src/main.js`): the API
  explicitly loads `.env` via `dotenv` (rather than relying on Prisma's
  auto-loading, which wasn't reliable in every environment tested) and
  allows cross-origin requests, since frontend and API can be served from
  different origins (e.g. two different Codespaces-forwarded URLs).
- **Tests** (`api/src/__tests__/`): 17 tests total. 15 unit tests (fare
  math, matching, lifecycle transitions) plus two integration tests gated
  behind a live `DATABASE_URL`: the Nusrat-vs-Shirin concurrency race, and a
  regression test for a real matching bug (below).

## Verified end-to-end, not just written

This system has been proven correct at every layer, against a live
Postgres, through both `curl` and the actual browser UI, including finding
and fixing two real bugs that no unit test caught:

- **Matching + fare split**: Nusrat (Banani to Mohakhali) and Rafiq (Banani
  to Gulshan 1) pool correctly, with fares of exactly 4922 and 4538 paisa.
  Verified via `curl`, via the Prisma-native test suite, and via the actual
  passenger UI in a browser, all agreeing to the paisa.
- **Concurrency**: the last-seat race (`SELECT ... FOR UPDATE`) was run for
  real against live Postgres. Two transactions fired via `Promise.all`, one
  artificially holding its lock for 150ms, and it resolved correctly every
  time: exactly one claim succeeds, `occupied_seats` never exceeds capacity.
  The DB trigger backstop was separately confirmed to reject a raw SQL
  attempt to overbook, bypassing the app entirely.
- **Full driver lifecycle**: both passengers walked through
  `MATCHED -> DRIVER_ARRIVED -> STARTED -> COMPLETED` via the driver
  manifest UI, with each ride's state transitioning independently and
  correctly.

### Two real bugs found through manual testing (and fixed)

1. **Candidate-matching regression.** `POST /rides`'s matching query used to
   filter out any request that already had a `poolId` assigned, but solo
   requests get a `poolId` immediately (see "Pool assignment" above). So a
   second passenger's request that should have matched with an earlier solo
   one was silently treated as solo too, charging the full fare instead of
   the pooled discount. Caught by manually walking through the exact
   Nusrat to Rafiq flow via `curl` and checking the actual fare returned.
   Fixed, and locked in with a regression test
   (`api/src/__tests__/rides-matching.test.js`).
2. **Test-isolation bug that deleted real data.** The regression test above
   initially assumed it was creating its own isolated Tesla/pool, but pool
   assignment picks any online Tesla via `findFirst`, so the test silently
   grabbed the real seeded Bullet Tesla instead of its own, pooled its fake
   test users into the real Nusrat/Rafiq pool, and then deleted that real
   pool in its cleanup step. Caught by checking the database directly after
   a test run and noticing the real pool was gone. Fixed by having the test
   temporarily take every other online Tesla offline for its duration, then
   restoring them afterward.

One caveat from originally building this in a network-sandboxed
environment: Prisma's query-engine binary couldn't be generated there (no
access to `binaries.prisma.sh`), so an earlier version of this README
described running the concurrency logic through the raw `pg` driver as a
workaround. That limitation doesn't apply in a normal environment (e.g.
GitHub Codespaces). This has since been run for real with Prisma generating
normally, migrations applying, and every test (including the Prisma-native
concurrency and regression tests) passing against live Postgres.

## Running it

**Backend:**
```bash
cp .env.example api/.env          # fill in JWT_SECRET at minimum
docker compose up -d db
cd api
npm install
npx prisma migrate dev --name init
docker compose exec -T db psql -U tesla -d tesla_pool < prisma/sql/enforce_capacity_trigger.sql
npx prisma db seed
npm run dev                        # API on :4000
```

**Frontend** (separate terminal):
```bash
cd web
cp .env.local.example .env.local   # points at http://localhost:4000 by default;
                                    # update if your API is on a different origin
                                    # (e.g. a Codespaces-forwarded URL)
npm install
npm run dev                        # UI on :3000
```

If frontend and API are on different origins (e.g. two different Codespaces
forwarded ports), make sure `NEXT_PUBLIC_API_BASE` in `web/.env.local`
points at the API's actual reachable URL, and that port's visibility is set
to Public in the Ports panel.

Run the unit tests any time (no DB needed):
```bash
cd api && npm test
```

The DB-dependent tests (concurrency + matching regression) auto-detect
`DATABASE_URL` from `.env` via Jest's `setupFiles` config, so there's no
need to pass it manually. With the DB running and seeded, `npm test` alone
runs all 17.

### Demo walkthrough (matches the plan's worked example)

1. Register or use the seeded accounts (`01700000002` Nusrat, `01700000003`
   Rafiq, `01700000001` Jashim the driver, all using password
   `password123`).
2. Log in as Nusrat, request Banani to Mohakhali.
3. Log in as Rafiq, request Banani to Gulshan 1. Should show "Pooled with
   another passenger", fare 45.38 BDT.
4. Each passenger needs to claim their seat via `POST /pools/:poolId/claim`
   (get the pool ID from the ride response or the `pools` table). **This
   step isn't wired into the passenger UI yet**, see "Known gaps" below.
5. Log in as Jashim, go to `/driver`, paste the pool ID, load the manifest,
   and step each passenger through arrive, start, and complete.

## Known gaps

- **Passenger UI doesn't call the claim endpoint.** `/passenger` shows the
  match and fare, but reserving the actual seat currently has to be done
  via `curl` (see step 4 above). Wiring a "Confirm seat" button into the
  passenger page is the natural next piece of UI work.
- **Pools don't auto-complete.** Once every ride request in a pool reaches
  `COMPLETED`, the `pools.status` field stays `FORMING` rather than being
  updated. Cosmetic for the demo, but worth fixing before this goes
  further.
- **`POST /pools/:id/claim`'s idempotency check isn't being enforced as
  strictly as intended.** A request without an `Idempotency-Key` header was
  observed succeeding during manual testing when it should require one per
  `api/src/middleware/idempotency.js`. Flagged for follow-up, not yet
  root-caused.
- Per the plan's lean-MVP scope, the bonus scaling items (Section 13)
  remain deliberately design-only. They're the "what changes at scale"
  answer, not part of the MVP.
