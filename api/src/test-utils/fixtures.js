// Shared helpers for the integration tests that need a live database.
// Every helper records what it creates so cleanup() can remove exactly that
// and nothing else. Teslas are created OFFLINE on purpose: POST /rides picks
// "any ONLINE Tesla" via findFirst, so an ONLINE test Tesla could be picked
// up by an unrelated test (or by the real demo data) and get polluted.
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

function createFixtures(label) {
  const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const zone = `__TEST_ZONE_${label}_${run}`;
  const keyPrefix = `${label}-${run}-`;
  let keyCounter = 0;
  const made = { users: [], teslas: [], pools: [], rides: [] };

  return {
    zone,

    auth(user) {
      const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
      return { Authorization: `Bearer ${token}` };
    },

    nextKey() {
      keyCounter += 1;
      return `${keyPrefix}${keyCounter}`;
    },

    async makeUser(name, role) {
      const user = await prisma.user.create({
        data: { name, phone: `${name}-${run}-${Math.random()}`, role, passwordHash: "x" },
      });
      made.users.push(user.id);
      return user;
    },

    async makePool(driver, capacity) {
      const tesla = await prisma.tesla.create({
        data: { driverId: driver.id, plateNumber: `TEST-${run}`, capacity, status: "OFFLINE" },
      });
      made.teslas.push(tesla.id);
      const pool = await prisma.pool.create({
        data: { teslaId: tesla.id, status: "FORMING", occupiedSeats: 0 },
      });
      made.pools.push(pool.id);
      return pool;
    },

    async makeRide(passenger, { status = "REQUESTED", poolId = null } = {}) {
      const ride = await prisma.rideRequest.create({
        data: {
          passengerId: passenger.id,
          pickupZone: zone,
          dropoffZone: zone,
          pickupLat: 23.7937,
          pickupLng: 90.4066,
          dropoffLat: 23.7641,
          dropoffLng: 90.3948,
          status,
          poolId,
        },
      });
      made.rides.push(ride.id);
      return ride;
    },

    async rideStatus(id) {
      const ride = await prisma.rideRequest.findUnique({ where: { id } });
      return ride.status;
    },

    async cleanup() {
      await prisma.statusHistory.deleteMany({ where: { rideRequestId: { in: made.rides } } });
      await prisma.fare.deleteMany({ where: { rideRequestId: { in: made.rides } } });
      await prisma.payment.deleteMany({ where: { rideRequestId: { in: made.rides } } });
      await prisma.rideRequest.deleteMany({ where: { id: { in: made.rides } } });
      await prisma.pool.deleteMany({ where: { id: { in: made.pools } } });
      await prisma.tesla.deleteMany({ where: { id: { in: made.teslas } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      await prisma.idempotencyKey.deleteMany({ where: { key: { startsWith: keyPrefix } } });
      await prisma.$disconnect();
    },
  };
}

module.exports = { createFixtures };
