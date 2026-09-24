// Integration test for Section 7's core scenario: Nusrat and Shirin racing
// for Bullet's last seat must never both succeed.
//
// Requires a live Postgres with migrations applied — run:
//   docker compose up -d db
//   npx prisma migrate deploy && psql "$DATABASE_URL" -f prisma/sql/enforce_capacity_trigger.sql
//   npm test -- concurrency
//
// Skips itself automatically if DATABASE_URL isn't set, so `npm test` still
// passes in environments without a DB (e.g. a quick CI lint stage).

const hasDb = !!process.env.DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb("POST /pools/:id/claim under concurrency", () => {
  let request, prisma, app;
  const createdUserIds = [];
  const createdTeslaIds = [];
  const createdPoolIds = [];
  const createdRideRequestIds = [];

  // Bug found via manual Codespaces testing: this test used to reuse the
  // same "Banani"/"Mohakhali" zone strings as the real demo/seed data and
  // never cleaned up, so a leftover REQUESTED row from a prior test run
  // would silently get pooled with real requests later. Using an isolated
  // zone name (never matched by real matching logic) plus explicit cleanup
  // fixes both problems.
  const TEST_ZONE = `__TEST_ZONE_${Date.now()}`;

  beforeAll(() => {
    prisma = require("../lib/prisma");
    const { createApp } = require("../app");
    app = createApp();
    request = require("supertest")(app);
  });

  afterAll(async () => {
    await prisma.statusHistory.deleteMany({ where: { rideRequestId: { in: createdRideRequestIds } } });
    await prisma.fare.deleteMany({ where: { rideRequestId: { in: createdRideRequestIds } } });
    await prisma.rideRequest.deleteMany({ where: { id: { in: createdRideRequestIds } } });
    await prisma.pool.deleteMany({ where: { id: { in: createdPoolIds } } });
    await prisma.tesla.deleteMany({ where: { id: { in: createdTeslaIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it("lets exactly one of two simultaneous claims for the last seat succeed", async () => {
    const driver = await prisma.user.create({
      data: { name: "Test Driver", phone: `driver-${Date.now()}`, role: "DRIVER", passwordHash: "x" },
    });
    createdUserIds.push(driver.id);

    const tesla = await prisma.tesla.create({
      data: { driverId: driver.id, plateNumber: "TEST-1", capacity: 1, status: "ONLINE" },
    });
    createdTeslaIds.push(tesla.id);

    const pool = await prisma.pool.create({
      data: { teslaId: tesla.id, status: "FORMING", occupiedSeats: 0 },
    });
    createdPoolIds.push(pool.id);

    const [nusrat, shirin] = await Promise.all(
      ["Nusrat", "Shirin"].map((name) =>
        prisma.user.create({ data: { name, phone: `${name}-${Date.now()}-${Math.random()}`, role: "PASSENGER", passwordHash: "x" } })
      )
    );
    createdUserIds.push(nusrat.id, shirin.id);

    const [reqNusrat, reqShirin] = await Promise.all(
      [nusrat, shirin].map((u) =>
        prisma.rideRequest.create({
          data: {
            passengerId: u.id,
            pickupZone: TEST_ZONE,
            dropoffZone: TEST_ZONE,
            pickupLat: 23.7937,
            pickupLng: 90.4066,
            dropoffLat: 23.7805,
            dropoffLng: 90.4058,
            status: "REQUESTED",
          },
        })
      )
    );
    createdRideRequestIds.push(reqNusrat.id, reqShirin.id);

    const jwt = require("jsonwebtoken");
    const token = (userId) => jwt.sign({ sub: userId, role: "PASSENGER" }, process.env.JWT_SECRET || "test-secret");

    const [resA, resB] = await Promise.all([
      request
        .post(`/pools/${pool.id}/claim`)
        .set("Authorization", `Bearer ${token(nusrat.id)}`)
        .set("Idempotency-Key", `nusrat-claim-${Date.now()}`)
        .send({ rideRequestId: reqNusrat.id }),
      request
        .post(`/pools/${pool.id}/claim`)
        .set("Authorization", `Bearer ${token(shirin.id)}`)
        .set("Idempotency-Key", `shirin-claim-${Date.now()}`)
        .send({ rideRequestId: reqShirin.id }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalPool = await prisma.pool.findUnique({ where: { id: pool.id } });
    expect(finalPool.occupiedSeats).toBe(1);
  });
});
