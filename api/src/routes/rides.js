const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { isPoolable, detourRatios, haversineKm } = require("../lib/geo");
const { soloFarePaisa, splitPooledFare } = require("../lib/fare");
const { applyTransition } = require("../lib/lifecycle");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

// Finds an available (ONLINE) Tesla and its current FORMING pool, creating
// one if needed. Assignment here only sets ride_requests.pool_id, it does
// NOT reserve a seat or touch pools.occupied_seats. Reserving a seat is
// exclusively POST /pools/:id/claim's job (Section 7's SELECT ... FOR UPDATE
// path), so multiple ride requests can be assigned to the same pool while
// only `capacity` of them will actually succeed at claim time, that's by
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

// POST /rides, create a ride request, then look for an existing REQUESTED
// request it can pool with (Section 5's detour-ratio rule), and assign the
// resulting request(s) to a FORMING pool on an available Tesla. This does
// NOT reserve a seat, claiming happens separately via POST /pools/:id/claim
// so the concurrency-sensitive step stays isolated to one endpoint (Section 7).
router.post("/", requireAuth, asyncHandler(async (req, res) => {
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

  // Look for a poolable candidate: another REQUESTED request sharing this
  // pickup zone whose detour ratio clears the threshold. Deliberately NOT
  // filtered by poolId here, a request can already be tentatively assigned
  // to a FORMING pool (as a solo rider) without having claimed a seat yet,
  // and should still be eligible to match. (This used to filter poolId:
  // null, which caused a real bug: once solo requests got assigned a pool,
  // they became invisible to this query and later-arriving requests that
  // should have matched with them were silently treated as solo instead,
  // caught via manual Codespaces testing, not by the unit tests, since the
  // unit tests exercise geo.js/fare.js directly rather than this route.)
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
    // No pool partner yet, solo fare stands until/unless a later request pools with this one.
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
      note: "No pool partner yet, solo fare applies. Call POST /pools/:poolId/claim to reserve your seat.",
    });
  }

  // Found a match: compute both fares via the savings split (Section 6),
  // then create a FORMING pool sized for this Tesla-agnostic step, actual
  // seat capacity is enforced at claim time (Section 7), not here.
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
}));

// POST /rides/:id/cancel, only valid before STARTED (Section 4).
router.post("/:id/cancel", requireAuth, asyncHandler(async (req, res) => {
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
    throw err; // let asyncHandler/central error middleware handle anything unexpected
  }
}));

// GET /rides, the calling passenger's own ride history, newest first.
// Scoped by passengerId from the JWT, never from a query param, so one
// passenger can't list another's rides. Capped so a long history can't
// turn into an unbounded response.
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const rideRequests = await prisma.rideRequest.findMany({
    where: { passengerId: req.user.id },
    include: { fare: true },
    orderBy: { requestedAt: "desc" },
    take: limit,
  });
  return res.json({ rideRequests });
}));

// GET /rides/:id, a passenger can only see their own ride.
router.get("/:id", requireAuth, asyncHandler(async (req, res) => {
  const rideRequest = await prisma.rideRequest.findUnique({
    where: { id: req.params.id },
    include: { fare: true },
  });
  if (!rideRequest) return res.status(404).json({ error: "Not found" });
  if (rideRequest.passengerId !== req.user.id) {
    return res.status(403).json({ error: "Not your ride request" });
  }
  return res.json({ rideRequest });
}));

module.exports = router;
