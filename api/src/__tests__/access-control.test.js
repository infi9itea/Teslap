// Integration tests for the access-control and lifecycle rules the brief
// lists under Testing: users can't modify another user's ride, cancellation
// rules hold, invalid state transitions are rejected. Also covers a pool
// completing automatically when its last ride completes.
//
// Uses the story cast (Jashim drives; Nusrat and Rafiq ride). Needs a live
// Postgres, same gating as the other integration tests.

const hasDb = !!process.env.DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

jest.setTimeout(30000);

describeIfDb("access control and ride lifecycle over HTTP", () => {
  let fx, prisma, request;
  let jashim, otherDriver, nusrat, rafiq, pool;

  beforeAll(async () => {
    const { createFixtures } = require("../test-utils/fixtures");
    prisma = require("../lib/prisma");
    request = require("supertest")(require("../app").createApp());
    fx = createFixtures("access");

    jashim = await fx.makeUser("Jashim", "DRIVER");
    otherDriver = await fx.makeUser("OtherDriver", "DRIVER");
    nusrat = await fx.makeUser("Nusrat", "PASSENGER");
    rafiq = await fx.makeUser("Rafiq", "PASSENGER");
    pool = await fx.makePool(jashim, 3);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  describe("passengers and their own rides", () => {
    it("lets a passenger view their own ride but not someone else's", async () => {
      const ride = await fx.makeRide(nusrat);

      const own = await request.get(`/rides/${ride.id}`).set(fx.auth(nusrat));
      expect(own.status).toBe(200);
      expect(own.body.rideRequest.id).toBe(ride.id);

      const other = await request.get(`/rides/${ride.id}`).set(fx.auth(rafiq));
      expect(other.status).toBe(403);
    });

    it("lets a passenger cancel their own ride but not someone else's", async () => {
      const ride = await fx.makeRide(nusrat);

      const byOther = await request.post(`/rides/${ride.id}/cancel`).set(fx.auth(rafiq));
      expect(byOther.status).toBe(403);
      expect(await fx.rideStatus(ride.id)).toBe("REQUESTED");

      const byOwner = await request.post(`/rides/${ride.id}/cancel`).set(fx.auth(nusrat));
      expect(byOwner.status).toBe(200);
      expect(await fx.rideStatus(ride.id)).toBe("CANCELLED");
    });

    it("does not let a passenger claim a seat for someone else's ride", async () => {
      const ride = await fx.makeRide(nusrat);
      const before = await prisma.pool.findUnique({ where: { id: pool.id } });

      const res = await request
        .post(`/pools/${pool.id}/claim`)
        .set(fx.auth(rafiq))
        .set("Idempotency-Key", fx.nextKey())
        .send({ rideRequestId: ride.id });

      expect(res.status).toBe(403);
      expect(await fx.rideStatus(ride.id)).toBe("REQUESTED");
      const after = await prisma.pool.findUnique({ where: { id: pool.id } });
      expect(after.occupiedSeats).toBe(before.occupiedSeats);
    });

    it("does not let a driver claim seats", async () => {
      const ride = await fx.makeRide(nusrat);

      const res = await request
        .post(`/pools/${pool.id}/claim`)
        .set(fx.auth(jashim))
        .set("Idempotency-Key", fx.nextKey())
        .send({ rideRequestId: ride.id });

      expect(res.status).toBe(403);
      expect(await fx.rideStatus(ride.id)).toBe("REQUESTED");
    });
  });

  describe("cancellation rules", () => {
    it.each(["STARTED", "COMPLETED"])("rejects cancelling a ride that is already %s", async (status) => {
      const ride = await fx.makeRide(nusrat, { status, poolId: pool.id });

      const res = await request.post(`/rides/${ride.id}/cancel`).set(fx.auth(nusrat));

      expect(res.status).toBe(409);
      expect(await fx.rideStatus(ride.id)).toBe(status);
    });

    it("allows cancelling before the ride starts", async () => {
      const ride = await fx.makeRide(nusrat, { status: "MATCHED", poolId: pool.id });

      const res = await request.post(`/rides/${ride.id}/cancel`).set(fx.auth(nusrat));

      expect(res.status).toBe(200);
      expect(await fx.rideStatus(ride.id)).toBe("CANCELLED");
    });
  });

  describe("driver endpoints and state transitions", () => {
    it("does not let a driver advance a ride on another driver's Tesla", async () => {
      const ride = await fx.makeRide(nusrat, { status: "MATCHED", poolId: pool.id });

      const res = await request.post(`/driver/rides/${ride.id}/arrive`).set(fx.auth(otherDriver));

      expect(res.status).toBe(403);
      expect(await fx.rideStatus(ride.id)).toBe("MATCHED");
    });

    it("does not let a passenger use driver endpoints", async () => {
      const ride = await fx.makeRide(nusrat, { status: "MATCHED", poolId: pool.id });

      const res = await request.post(`/driver/rides/${ride.id}/arrive`).set(fx.auth(nusrat));

      expect(res.status).toBe(403);
      expect(await fx.rideStatus(ride.id)).toBe("MATCHED");
    });

    it("rejects skipping lifecycle steps", async () => {
      const ride = await fx.makeRide(nusrat, { status: "MATCHED", poolId: pool.id });

      const start = await request.post(`/driver/rides/${ride.id}/start`).set(fx.auth(jashim));
      expect(start.status).toBe(409);

      const complete = await request.post(`/driver/rides/${ride.id}/complete`).set(fx.auth(jashim));
      expect(complete.status).toBe(409);

      expect(await fx.rideStatus(ride.id)).toBe("MATCHED");
    });

    it("completes the pool automatically when its last ride completes", async () => {
      const ownPool = await fx.makePool(jashim, 3);
      const first = await fx.makeRide(nusrat, { status: "MATCHED", poolId: ownPool.id });
      const second = await fx.makeRide(rafiq, { status: "MATCHED", poolId: ownPool.id });

      const drive = async (ride) => {
        for (const step of ["arrive", "start", "complete"]) {
          const res = await request.post(`/driver/rides/${ride.id}/${step}`).set(fx.auth(jashim));
          expect(res.status).toBe(200);
        }
      };

      await drive(first);
      let current = await prisma.pool.findUnique({ where: { id: ownPool.id } });
      expect(current.status).toBe("FORMING"); // one passenger is still on board

      await drive(second);
      current = await prisma.pool.findUnique({ where: { id: ownPool.id } });
      expect(current.status).toBe("COMPLETED");
      expect(current.completedAt).not.toBeNull();
    });
  });
});
