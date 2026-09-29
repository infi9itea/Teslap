// Integration tests for recording a cash payment. Jashim drives Bullet;
// Nusrat rides. Needs a live Postgres, same gating as the other
// integration tests.

const hasDb = !!process.env.DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

jest.setTimeout(30000);

describeIfDb("cash payment over HTTP", () => {
  let fx, prisma, request;
  let jashim, otherDriver, nusrat, pool;

  async function makeFare(rideId, totalFarePaisa) {
    return prisma.fare.create({
      data: {
        rideRequestId: rideId,
        baseFarePaisa: 3000,
        distanceChargePaisa: totalFarePaisa - 3000,
        poolDiscountPaisa: 0,
        totalFarePaisa,
      },
    });
  }

  beforeAll(async () => {
    const { createFixtures } = require("../test-utils/fixtures");
    prisma = require("../lib/prisma");
    request = require("supertest")(require("../app").createApp());
    fx = createFixtures("cash");

    jashim = await fx.makeUser("Jashim", "DRIVER");
    otherDriver = await fx.makeUser("OtherDriver", "DRIVER");
    nusrat = await fx.makeUser("Nusrat", "PASSENGER");
    pool = await fx.makePool(jashim, 3);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("refuses cash collection before the ride is completed", async () => {
    const ride = await fx.makeRide(nusrat, { status: "STARTED", poolId: pool.id });
    await makeFare(ride.id, 4922);

    const res = await request.post(`/driver/rides/${ride.id}/collect-cash`).set(fx.auth(jashim));
    expect(res.status).toBe(409);
    expect(await prisma.payment.count({ where: { rideRequestId: ride.id } })).toBe(0);
  });

  it("records the stored fare total as a PAID cash payment", async () => {
    const ride = await fx.makeRide(nusrat, { status: "COMPLETED", poolId: pool.id });
    await makeFare(ride.id, 4922);

    const res = await request.post(`/driver/rides/${ride.id}/collect-cash`).set(fx.auth(jashim));
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ method: "CASH", status: "PAID", amountPaisa: 4922 });

    // The passenger sees the payment on their own ride.
    const seen = await request.get(`/rides/${ride.id}`).set(fx.auth(nusrat));
    expect(seen.body.rideRequest.payment.status).toBe("PAID");
  });

  it("is idempotent: a second collect returns the same payment, no duplicate", async () => {
    const ride = await fx.makeRide(nusrat, { status: "COMPLETED", poolId: pool.id });
    await makeFare(ride.id, 4538);

    const first = await request.post(`/driver/rides/${ride.id}/collect-cash`).set(fx.auth(jashim));
    const second = await request.post(`/driver/rides/${ride.id}/collect-cash`).set(fx.auth(jashim));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.payment.id).toBe(first.body.payment.id);
    expect(await prisma.payment.count({ where: { rideRequestId: ride.id } })).toBe(1);
  });

  it("does not let another driver or a passenger record payment", async () => {
    const ride = await fx.makeRide(nusrat, { status: "COMPLETED", poolId: pool.id });
    await makeFare(ride.id, 4922);

    const byOtherDriver = await request.post(`/driver/rides/${ride.id}/collect-cash`).set(fx.auth(otherDriver));
    expect(byOtherDriver.status).toBe(403);

    const byPassenger = await request.post(`/driver/rides/${ride.id}/collect-cash`).set(fx.auth(nusrat));
    expect(byPassenger.status).toBe(403);

    expect(await prisma.payment.count({ where: { rideRequestId: ride.id } })).toBe(0);
  });
});
