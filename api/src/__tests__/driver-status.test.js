// Integration tests for the driver's Tesla status toggle and current-pool
// lookup. Jashim drives Bullet; Nusrat rides. Needs a live Postgres, same
// gating as the other integration tests.
//
// The fixture Tesla starts OFFLINE on purpose (see test-utils/fixtures.js).
// The one test that flips it ONLINE flips it straight back, so an unrelated
// test running in parallel can't get assigned to it.

const hasDb = !!process.env.DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

jest.setTimeout(30000);

describeIfDb("driver Tesla status over HTTP", () => {
  let fx, prisma, request;
  let jashim, nusrat, pool;

  beforeAll(async () => {
    const { createFixtures } = require("../test-utils/fixtures");
    prisma = require("../lib/prisma");
    request = require("supertest")(require("../app").createApp());
    fx = createFixtures("driverstatus");

    jashim = await fx.makeUser("Jashim", "DRIVER");
    nusrat = await fx.makeUser("Nusrat", "PASSENGER");
    pool = await fx.makePool(jashim, 3);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("returns the driver's Tesla and current pool", async () => {
    const res = await request.get("/driver/tesla").set(fx.auth(jashim));
    expect(res.status).toBe(200);
    expect(res.body.tesla.id).toBe(pool.teslaId);
    expect(res.body.currentPool.id).toBe(pool.id);
  });

  it("lets the driver go online and back offline", async () => {
    const on = await request.patch("/driver/tesla/status").set(fx.auth(jashim)).send({ status: "ONLINE" });
    expect(on.status).toBe(200);
    expect(on.body.tesla.status).toBe("ONLINE");

    const off = await request.patch("/driver/tesla/status").set(fx.auth(jashim)).send({ status: "OFFLINE" });
    expect(off.status).toBe(200);
    expect(off.body.tesla.status).toBe("OFFLINE");
  });

  it("rejects an invalid status value", async () => {
    const res = await request.patch("/driver/tesla/status").set(fx.auth(jashim)).send({ status: "SLEEPING" });
    expect(res.status).toBe(400);
  });

  it("does not let a passenger use the driver endpoints", async () => {
    const get = await request.get("/driver/tesla").set(fx.auth(nusrat));
    expect(get.status).toBe(403);

    const patch = await request.patch("/driver/tesla/status").set(fx.auth(nusrat)).send({ status: "ONLINE" });
    expect(patch.status).toBe(403);
  });

  it("refuses to go offline while a passenger holds a seat, then allows it once the ride ends", async () => {
    const ride = await fx.makeRide(nusrat, { status: "MATCHED", poolId: pool.id });

    const blocked = await request.patch("/driver/tesla/status").set(fx.auth(jashim)).send({ status: "OFFLINE" });
    expect(blocked.status).toBe(409);

    await prisma.rideRequest.update({ where: { id: ride.id }, data: { status: "CANCELLED" } });

    const allowed = await request.patch("/driver/tesla/status").set(fx.auth(jashim)).send({ status: "OFFLINE" });
    expect(allowed.status).toBe(200);
  });
});
