const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { isPoolable, detourRatios, haversineKm } = require("../lib/geo");
const { soloFarePaisa, splitPooledFare } = require("../lib/fare");
const { applyTransition } = require("../lib/lifecycle");

const router = express.Router();

// Finds an available (ONLINE) Tesla and its current FORMING pool, creating
// one if needed. Assignment here only sets ride_requests.pool_id — it does
// NOT reserve a seat or touch pools.occupied_seats. Reserving a seat is
// exclusively POST /pools/:id/claim's job (Section 7's SELECT ... FOR UPDATE
// path), so multiple ride requests can be assigned to the same pool while
// only `capacity` of them will actually succeed at claim time — that's by
// design, not a bug.
async function findOrCreateFormingPool(tx) {
  const tesla = await tx.tesla.findFirst({ where: { status: "ONLINE" } });
  if (!tesla) {
    const err = new Error("No online Tesla available to assign this ride to");
    err.status = 503;
    throw err;
  }

  let pool = await tx.pool.findFirst({ where: { teslaId: tesla.id, status: "FORMING" } });
  if (!pool) {
    pool = await tx.pool.create({ data: { teslaId: tesla.id, status: "FORMING", occupiedSeats: 0 } });
  }
  return pool;
}

// POST /rides — create a ride request, then look for an existing REQUESTED
// request it can pool with (Section 5's detour-ratio rule), and assign the
// resulting request(s) to a FORMING pool on an available Tesla. This does
// NOT reserve a seat — claiming happens separately via POST /pools/:id/claim
// so the concurrency-sensitive step stays isolated to one endpoint (Section 7).
router.post("/", requireAuth, async (req, res) => {
  const { pickupZone, dropoffZone, pickupLat, pickupLng, dropoffLat, dropoffLng, seatsRequested } = req.body;

  if ([pickupLat, pickupLng, dropoffLat, dropoffLng].some((v) => typeof v !== "number")) {
    return res.status(400).json({ error: "pickupLat/pickupLng/dropoffLat/dropoffLng must be numbers" });
  }

  const rideRequest = await prisma.rideRequest.create({
    data: {
      passengerId: req.user.id,
      pickupZone,
      dropoffZone,
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng,
      seatsRequested: seatsRequested || 1,
      status: "REQUESTED",
    },
  });
  await prisma.statusHistory.create({
    data: { rideRequestId: rideRequest.id, fromStatus: null, toStatus: "REQUESTED" },
  });

  const candidates = await prisma.rideRequest.findMany({
    where: {
      status: "REQUESTED",
      pickupZone,
      id: { not: rideRequest.id },
    },
    take: 10,
  });

  const self = {
    id: rideRequest.id,
    pickup: { lat: pickupLat, lng: pickupLng },
    dropoff: { lat: dropoffLat, lng: dropoffLng },
  };

  const match = candidates.find((c) =>
    isPoolable(self, { id: c.id, pickup: { lat: c.pickupLat, lng: c.pickupLng }, dropoff: { lat: c.dropoffLat, lng: c.dropoffLng } })
  );

  if (!match) {
    const directKm = haversineKm(self.pickup, self.dropoff);
    const solo = soloFarePaisa(directKm);

    let pool;
    try {
      pool = await prisma.$transaction(async (tx) => {
        await tx.fare.create({
          data: {
            rideRequestId: rideRequest.id,
            baseFarePaisa: 3000,
            distanceChargePaisa: solo - 3000,
            poolDiscountPaisa: 0,
            totalFarePaisa: solo,
          },
        });
        const assignedPool = await findOrCreateFormingPool(tx);
        await tx.rideRequest.update({ where: { id: rideRequest.id }, data: { poolId: assignedPool.id } });
        return assignedPool;
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    return res.status(201).json({
      rideRequest: { ...rideRequest, poolId: pool.id },
      pooledWith: null,
      poolId: pool.id,
      note: "No pool partner yet — solo fare applies. Call POST /pools/:poolId/claim to reserve your seat.",
    });
  }

  const other = { id: match.id, pickup: { lat: match.pickupLat, lng: match.pickupLng }, dropoff: { lat: match.dropoffLat, lng: match.dropoffLng } };
  const { route, directA, directB } = detourRatios(self, other);
  const soloBackToBack = directA + directB;
  const split = splitPooledFare(directA, directB, route.totalDistance, soloBackToBack);

  let pool;
  try {
    pool = await prisma.$transaction(async (tx) => {
      await tx.fare.create({
        data: {
          rideRequestId: rideRequest.id,
          baseFarePaisa: split.passengerA.baseFarePaisa,
          distanceChargePaisa: split.passengerA.distanceChargePaisa,
          poolDiscountPaisa: split.passengerA.poolDiscountPaisa,
          totalFarePaisa: split.passengerA.totalFarePaisa,
        },
      });
      await tx.fare.upsert({
        where: { rideRequestId: match.id },
        create: {
          rideRequestId: match.id,
          baseFarePaisa: split.passengerB.baseFarePaisa,
          distanceChargePaisa: split.passengerB.distanceChargePaisa,
          poolDiscountPaisa: split.passengerB.poolDiscountPaisa,
          totalFarePaisa: split.passengerB.totalFarePaisa,
        },
        update: {
          poolDiscountPaisa: split.passengerB.poolDiscountPaisa,
          totalFarePaisa: split.passengerB.totalFarePaisa,
        },
      });

      const assignedPool = await findOrCreateFormingPool(tx);
      await tx.rideRequest.update({ where: { id: rideRequest.id }, data: { poolId: assignedPool.id } });
      await tx.rideRequest.update({ where: { id: match.id }, data: { poolId: assignedPool.id } });
      return assignedPool;
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  return res.status(201).json({
    rideRequest: { ...rideRequest, poolId: pool.id },
    pooledWith: match.id,
    poolId: pool.id,
    note: "Fares computed as a poolable pair. Call POST /pools/:poolId/claim to actually reserve your seat.",
  });
});

router.post("/:id/cancel", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const current = await prisma.rideRequest.findUnique({ where: { id } });
    if (!current) return res.status(404).json({ error: "Not found" });
    if (current.passengerId !== req.user.id) {
      return res.status(403).json({ error: "Not your ride request" });
    }

    await prisma.$transaction((tx) => applyTransition(tx, id, current.status, "CANCELLED"));
    return res.status(200).json({ status: "CANCELLED" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  const rideRequest = await prisma.rideRequest.findUnique({
    where: { id: req.params.id },
    include: { fare: true },
  });
  if (!rideRequest) return res.status(404).json({ error: "Not found" });
  if (rideRequest.passengerId !== req.user.id) {
    return res.status(403).json({ error: "Not your ride request" });
  }
  return res.json({ rideRequest });
});

module.exports = router;
