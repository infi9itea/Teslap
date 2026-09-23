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

  beforeAll(() => {
    prisma = require("../lib/prisma");
    const { createApp } = require("../app");
    app = createApp();
    request = require("supertest")(app);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets exactly one of two simultaneous claims for the last seat succeed", async () => {
    // Arrange: a Tesla with capacity 1, one seat already occupied by someone
    // else, so Nusrat and Shirin are both racing for the single last seat.
    const driver = await prisma.user.create({
      data: { name: "Test Driver", phone: `driver-${Date.now()}`, role: "DRIVER", passwordHash: "x" },
    });
    const tesla = await prisma.tesla.create({
      data: { driverId: driver.id, plateNumber: "TEST-1", capacity: 1, status: "ONLINE" },
    });
    const pool = await prisma.pool.create({
      data: { teslaId: tesla.id, status: "FORMING", occupiedSeats: 0 },
    });

    const [nusrat, shirin] = await Promise.all(
      ["Nusrat", "Shirin"].map((name) =>
        prisma.user.create({ data: { name, phone: `${name}-${Date.now()}-${Math.random()}`, role: "PASSENGER", passwordHash: "x" } })
      )
    );
    const [reqNusrat, reqShirin] = await Promise.all(
      [nusrat, shirin].map((u) =>
        prisma.rideRequest.create({
          data: {
            passengerId: u.id,
            pickupZone: "Banani",
            dropoffZone: "Mohakhali",
            pickupLat: 23.7937,
            pickupLng: 90.4066,
            dropoffLat: 23.7805,
            dropoffLng: 90.4058,
            status: "REQUESTED",
          },
        })
      )
    );

    const jwt = require("jsonwebtoken");
    const token = (userId) => jwt.sign({ sub: userId, role: "PASSENGER" }, process.env.JWT_SECRET || "test-secret");

    // Act: fire both claims at (as close to) the same instant.
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

    // Assert: exactly one succeeded, the other got a clean 409 conflict.
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalPool = await prisma.pool.findUnique({ where: { id: pool.id } });
    expect(finalPool.occupiedSeats).toBe(1); // never 2 — the whole point of the test
  });
});
