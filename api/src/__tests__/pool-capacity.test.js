// Bullet's capacity can never be exceeded, whether claims arrive one after
// another or all at the same instant. Complements concurrency.test.js (the
// two-people-one-seat race) with a larger pool and a sequential check.
//
// Needs a live Postgres, same gating as the other integration tests.

const hasDb = !!process.env.DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

jest.setTimeout(30000);

describeIfDb("pool capacity", () => {
  let fx, prisma, request;
  let jashim, nusrat, rafiq, shirin, tania;

  const claim = (user, pool, ride) =>
    request
      .post(`/pools/${pool.id}/claim`)
      .set(fx.auth(user))
      .set("Idempotency-Key", fx.nextKey())
      .send({ rideRequestId: ride.id });

  beforeAll(async () => {
    const { createFixtures } = require("../test-utils/fixtures");
    prisma = require("../lib/prisma");
    request = require("supertest")(require("../app").createApp());
    fx = createFixtures("capacity");

    jashim = await fx.makeUser("Jashim", "DRIVER");
    nusrat = await fx.makeUser("Nusrat", "PASSENGER");
    rafiq = await fx.makeUser("Rafiq", "PASSENGER");
    shirin = await fx.makeUser("Shirin", "PASSENGER");
    tania = await fx.makeUser("Tania", "PASSENGER");
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("rejects a claim once the pool is full, when claims arrive one after another", async () => {
    const pool = await fx.makePool(jashim, 2);
    const rides = [await fx.makeRide(nusrat), await fx.makeRide(rafiq), await fx.makeRide(shirin)];

    const first = await claim(nusrat, pool, rides[0]);
    const second = await claim(rafiq, pool, rides[1]);
    const third = await claim(shirin, pool, rides[2]);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 409]);
    expect(third.body.error).toMatch(/seat/i);
    expect(await fx.rideStatus(rides[2].id)).toBe("REQUESTED");

    const final = await prisma.pool.findUnique({ where: { id: pool.id } });
    expect(final.occupiedSeats).toBe(2);
  });

  it("lets exactly two of four simultaneous claims succeed on a two-seat pool", async () => {
    const pool = await fx.makePool(jashim, 2);
    const passengers = [nusrat, rafiq, shirin, tania];
    const rides = [];
    for (const passenger of passengers) rides.push(await fx.makeRide(passenger));

    const results = await Promise.all(passengers.map((p, i) => claim(p, pool, rides[i])));

    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409, 409]);

    const final = await prisma.pool.findUnique({ where: { id: pool.id } });
    expect(final.occupiedSeats).toBe(2);

    const matched = await prisma.rideRequest.count({
      where: { id: { in: rides.map((r) => r.id) }, status: "MATCHED" },
    });
    expect(matched).toBe(2);
  });
});
