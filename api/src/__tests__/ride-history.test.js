// Integration test for GET /rides, the passenger's own ride history.
// Uses the story cast: Nusrat has two rides, Rafiq has one. Each must see
// only their own. Needs a live Postgres, same gating as the other
// integration tests.

const hasDb = !!process.env.DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

jest.setTimeout(30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describeIfDb("passenger ride history over HTTP", () => {
  let fx, request;
  let nusrat, rafiq, nusratFirst, nusratSecond, rafiqRide;

  beforeAll(async () => {
    const { createFixtures } = require("../test-utils/fixtures");
    request = require("supertest")(require("../app").createApp());
    fx = createFixtures("history");

    nusrat = await fx.makeUser("Nusrat", "PASSENGER");
    rafiq = await fx.makeUser("Rafiq", "PASSENGER");

    nusratFirst = await fx.makeRide(nusrat);
    await sleep(10); // distinct requested_at so the ordering assertion is stable
    nusratSecond = await fx.makeRide(nusrat, { status: "CANCELLED" });
    rafiqRide = await fx.makeRide(rafiq);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("requires authentication", async () => {
    const res = await request.get("/rides");
    expect(res.status).toBe(401);
  });

  it("returns only the caller's own rides, newest first", async () => {
    const res = await request.get("/rides").set(fx.auth(nusrat));
    expect(res.status).toBe(200);

    const ids = res.body.rideRequests.map((r) => r.id);
    expect(ids).toEqual([nusratSecond.id, nusratFirst.id]);
    expect(ids).not.toContain(rafiqRide.id);
  });

  it("does not leak Nusrat's rides to Rafiq", async () => {
    const res = await request.get("/rides").set(fx.auth(rafiq));
    expect(res.status).toBe(200);
    expect(res.body.rideRequests.map((r) => r.id)).toEqual([rafiqRide.id]);
  });

  it("respects the limit query param", async () => {
    const res = await request.get("/rides?limit=1").set(fx.auth(nusrat));
    expect(res.status).toBe(200);
    expect(res.body.rideRequests).toHaveLength(1);
  });
});
