const hasDb = !!process.env.DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb("POST /rides — matching a solo-assigned request", () => {
  let request, prisma, jwt;
  const createdUserIds = [];
  const createdTeslaIds = [];
  const createdPoolIds = [];
  const createdRideRequestIds = [];

  const TEST_ZONE = `__TEST_ZONE_rides_${Date.now()}`;

  const BANANI = { lat: 23.7937, lng: 90.4066 };
  const MOHAKHALI = { lat: 23.764121548646127, lng: 90.39483713960288 };
  const GULSHAN1 = { lat: 23.7758931211846, lng: 90.38714301435537 };

  beforeAll(() => {
    prisma = require("../lib/prisma");
    jwt = require("jsonwebtoken");
    const { createApp } = require("../app");
    request = require("supertest")(createApp());
  });

  afterAll(async () => {
    await prisma.fare.deleteMany({ where: { rideRequestId: { in: createdRideRequestIds } } });
    await prisma.statusHistory.deleteMany({ where: { rideRequestId: { in: createdRideRequestIds } } });
    await prisma.rideRequest.deleteMany({ where: { id: { in: createdRideRequestIds } } });
    await prisma.pool.deleteMany({ where: { id: { in: createdPoolIds } } });
    await prisma.tesla.deleteMany({ where: { id: { in: createdTeslaIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it("pools a second request with an earlier request that already got assigned a solo pool", async () => {
    const driver = await prisma.user.create({
      data: { name: "Test Driver", phone: `driver-rides-${Date.now()}`, role: "DRIVER", passwordHash: "x" },
    });
    createdUserIds.push(driver.id);
    const tesla = await prisma.tesla.create({
      data: { driverId: driver.id, plateNumber: "TEST-RIDES", capacity: 3, status: "ONLINE" },
    });
    createdTeslaIds.push(tesla.id);

    const [nusrat, rafiq] = await Promise.all(
      ["Nusrat", "Rafiq"].map((name) =>
        prisma.user.create({ data: { name, phone: `${name}-rides-${Date.now()}-${Math.random()}`, role: "PASSENGER", passwordHash: "x" } })
      )
    );
    createdUserIds.push(nusrat.id, rafiq.id);

    const token = (userId) => jwt.sign({ sub: userId, role: "PASSENGER" }, process.env.JWT_SECRET || "test-secret");

    const nusratRes = await request
      .post("/rides")
      .set("Authorization", `Bearer ${token(nusrat.id)}`)
      .send({
        pickupZone: TEST_ZONE,
        dropoffZone: "Mohakhali",
        pickupLat: BANANI.lat,
        pickupLng: BANANI.lng,
        dropoffLat: MOHAKHALI.lat,
        dropoffLng: MOHAKHALI.lng,
      });

    expect(nusratRes.status).toBe(201);
    expect(nusratRes.body.pooledWith).toBeNull();
    createdRideRequestIds.push(nusratRes.body.rideRequest.id);
    const nusratPoolId = nusratRes.body.poolId;
    expect(nusratPoolId).toBeTruthy();

    const rafiqRes = await request
      .post("/rides")
      .set("Authorization", `Bearer ${token(rafiq.id)}`)
      .send({
        pickupZone: TEST_ZONE,
        dropoffZone: "Gulshan 1",
        pickupLat: BANANI.lat,
        pickupLng: BANANI.lng,
        dropoffLat: GULSHAN1.lat,
        dropoffLng: GULSHAN1.lng,
      });

    expect(rafiqRes.status).toBe(201);
    createdRideRequestIds.push(rafiqRes.body.rideRequest.id);

    expect(rafiqRes.body.pooledWith).toBe(nusratRes.body.rideRequest.id);
    expect(rafiqRes.body.poolId).toBe(nusratPoolId);
    createdPoolIds.push(nusratPoolId);

    const rafiqFare = await prisma.fare.findUnique({ where: { rideRequestId: rafiqRes.body.rideRequest.id } });
    expect(rafiqFare.poolDiscountPaisa).toBeGreaterThan(0);
    expect(rafiqFare.totalFarePaisa).toBeLessThan(5240);
  });
});
