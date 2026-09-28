# Dhaka Tesla Pool: API + Frontend

Working implementation of the design in `Dhaka_Tesla_Pool_Plan.md/.docx/.pdf`
(the full build plan: architecture, ERD, fare math, and the reasoning behind
every decision below lives there). This repo is the code that plan
describes, and every core flow has been run end-to-end through the real
browser UI against a live Postgres, not just unit-tested in isolation.

## Architecture

![System architecture](docs/images/architecture.png)

Browser talks to a Next.js frontend, which calls a plain Express API over
REST/JSON. The API is the only thing that talks to Postgres, which keeps
all the pooling/capacity logic transactionally consistent in one place
rather than split across services.

![Entity relationship diagram](docs/images/erd.png)

Money is stored as integer paisa everywhere (never float/decimal), and
`ride_requests.version` plus `pools.occupied_seats` are what the
concurrency design in Section 7 of the plan locks against.

![Ride lifecycle state machine](docs/images/lifecycle.png)

Every transition shown above is validated by `api/src/lib/lifecycle.js` and
written to `status_history`, so cancellation past `STARTED` is rejected and
every status change has an audit trail.

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
- **Docker deployment**: from a wiped database volume, a single
  `docker compose up --build` brought up the database, API, and frontend,
  applied the migration and the capacity trigger, seeded the demo data, and
  passed the API healthcheck, all without manual steps. Verified in GitHub
  Codespaces.

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

### With Docker (recommended, one command)

```bash
docker compose up --build
```

That's the whole setup. Compose starts three containers: Postgres, the API,
and the frontend. The API container waits for the database, applies the
migration, applies the DB-level capacity trigger, seeds the demo data
(Jashim, Nusrat, Rafiq, Shirin, and the Bullet Tesla), and only then starts
serving. Nothing has to be run by hand.

- Frontend: http://localhost:3000
- API: http://localhost:4000 (health check at `/health`)
- Demo logins: see "Demo walkthrough" below (password `password123`)
- Reset everything to a clean state: `docker compose down -v`

Defaults work with zero configuration. To override them, copy
`.env.example` to `.env` and edit `DB_PASSWORD`, `JWT_SECRET`, and so on.
Compose reads that root `.env` automatically.

Two Docker notes worth knowing:

- **How the API reaches Postgres.** By default the API connects through
  `host.docker.internal` (the host's published port 5432). This is the
  route verified to work in GitHub Codespaces, on Docker Desktop, and on
  regular Linux Docker. In Codespaces, direct container-to-container
  traffic by service name (`db`) did not work, so the host route is the
  default. On a normal Docker machine you can set `DB_HOST=db` in `.env`
  to use Compose's internal network instead (standard behaviour, but not
  something that could be verified in Codespaces).
- **Frontend API URL.** Next.js bakes `NEXT_PUBLIC_API_BASE` into the
  bundle at build time, and it is the URL the browser calls. It defaults to
  `http://localhost:4000`, which is right when Docker runs on your own
  machine. In Codespaces the browser needs the forwarded URL instead: set
  `NEXT_PUBLIC_API_BASE` in `.env` to the forwarded address of port 4000
  (and make that port Public), then run `docker compose up --build` again.

### Without Docker (local development)

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
- Per the plan's lean-MVP scope, the bonus scaling items (Section 13)
  remain deliberately design-only. They're the "what changes at scale"
  answer, not part of the MVP.

## Two more things found and fixed after the above was written

- **Pools now auto-complete.** Once every ride request in a pool reaches a
  terminal state (`COMPLETED` or `CANCELLED`), `api/src/routes/driver.js`
  now marks the pool itself `COMPLETED` too, instead of leaving
  `pools.status` stuck on `FORMING` forever.
- **A crash-on-error bug, more serious than it first looked.** Several route
  handlers (`/auth/login` among them) had no `try/catch` around their Prisma
  calls. In Express 4, an unhandled rejection from an async route handler
  doesn't just fail that one request, it can crash the entire Node process.
  This was found while trying to reproduce a suspected idempotency bug: the
  database had gone down, and the very next request to hit an unguarded
  route took the whole server down with it, which is almost certainly the
  real explanation for several "mysterious" outages earlier in development
  that looked like Codespace resets but may partly have been this. Fixed
  with a small `asyncHandler` wrapper (`api/src/lib/asyncHandler.js`)
  applied to every route across `auth.js`, `rides.js`, `pools.js`,
  `driver.js`, and the idempotency middleware, so any thrown or rejected
  error now reaches Express's centralized error handler and returns a
  clean 500 instead of ending the process.
- **The suspected idempotency bug did not reproduce.** After the crash-proofing
  fix above and a full clean restart of the database, API, and frontend, the
  exact scenario that originally looked broken (a claim request missing its
  `Idempotency-Key` header appearing to succeed) was retested directly with
  `curl -i` and correctly returned `400 Bad Request, "Idempotency-Key header
  is required"`. The likely explanation: the original test was run against a
  stale or restarted server process during a long, environment-flaky
  session, not against a genuine logic bug in
  `api/src/middleware/idempotency.js`. Recorded here rather than quietly
  dropped, since "we looked again and it wasn't actually broken" is a valid
  and honest outcome, not a gap.
- **The Docker setup was never actually tested until late, and it had
  real bugs.** Up to that point only the database container had ever been
  started with Docker; the API and frontend always ran directly on the
  host. Running `docker compose up` for the first time from a clean state
  exposed three problems, each fixed and re-verified:
  1. `node:20-slim` ships without OpenSSL, so Prisma failed to pick the
     right engine and `prisma migrate deploy` died with "Schema engine
     error". Fixed by installing OpenSSL in `api/Dockerfile`.
  2. The capacity trigger was only ever applied by hand with `psql`. Fixed
     with `api/scripts/apply-trigger.js`, run automatically at startup.
  3. The API could not reach Postgres from inside its container. The
     database's own healthcheck also passed too early, because the official
     Postgres image briefly runs a temporary socket-only server during first
     start. Fixed by making the healthcheck use TCP, adding
     `api/scripts/wait-for-db.js` (with a connection timeout so a network
     hang becomes a visible retry), and routing the API's connection
     through `host.docker.internal`. Debugging this took several rounds,
     including one where a fix appeared not to work because an updated
     compose file had not actually been applied, a reminder to verify the
     file on disk before theorizing about the network.

## AI usage

This project was built with Claude (Anthropic) as a collaborator across
design, implementation, and debugging.

**Accepted suggestion:** the detour-ratio matching rule (Section 5 of the
plan). My first instinct was a hardcoded zone-compatibility table ("Mohakhali
and Gulshan 1 are near each other"), which works but doesn't generalize and
isn't derived from anything real. Claude proposed computing an actual detour
ratio from haversine distance instead, the same approach used in real
carpooling matching research, with a documented, tunable threshold (1.3).
I accepted this because it's just as easy to hand-verify for grading as the
zone-table approach, but it's an actual formula rather than a guess, and it
degrades sensibly for routes that don't obviously belong on a fixed list.

**Rejected suggestion:** Claude's first draft of the concurrency section
described `SELECT ... FOR UPDATE` as merely "sufficient for MVP," almost
apologetically, positioning it as a stopgap rather than a considered choice.
I pushed back implicitly by asking for real-world grounding rather than
textbook advice, and the revised version correctly reframed pessimistic
locking as the deliberate, correct choice for high-contention resources like
a Tesla's last seat, not a shortcut. The lesson generalized: I stopped
accepting "good enough for MVP" framing without asking whether it was
actually the right engineering call or just the easy one.

**Where AI assistance mattered most in practice:** not the initial code
generation, but the debugging. Two real bugs made it into the codebase
despite passing unit tests: a candidate-matching regression that silently
charged full fare instead of the pooled discount, and a test-isolation bug
that deleted real demo data. Both were found only by manually running the
system end-to-end (via curl, then the browser) and checking actual output
against expected numbers, not by trusting that green tests meant correctness.
Claude helped root-cause both once the symptom was visible, but the manual
verification step (comparing real numbers against the plan's worked example)
is what surfaced them in the first place.
