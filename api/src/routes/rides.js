const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { isPoolable, detourRatios, haversineKm } = require("../lib/geo");
const { soloFarePaisa, splitPooledFare } = require("../lib/fare");
const { applyTransition } = require("../lib/lifecycle");

const router = express.Router();

// POST /rides — create a ride request, then look for an existing REQUESTED
// request it can pool with (Section 5's detour-ratio rule). This does NOT
// claim a seat — claiming happens separately via POST /pools/:id/claim so the
// concurrency-sensitive step stays isolated to one endpoint (Section 7).
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

  // Look for a poolable candidate: another REQUESTED request sharing this
  // pickup zone, not yet in a pool, whose detour ratio clears the threshold.
  const candidates = await prisma.rideRequest.findMany({
    where: {
      status: "REQUESTED",
      pickupZone,
      poolId: null,
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
    // No pool partner yet — solo fare stands until/unless a later request pools with this one.
    const directKm = haversineKm(self.pickup, self.dropoff);
    const solo = soloFarePaisa(directKm);
    await prisma.fare.create({
      data: {
        rideRequestId: rideRequest.id,
        baseFarePaisa: 3000,
        distanceChargePaisa: solo - 3000,
        poolDiscountPaisa: 0,
        totalFarePaisa: solo,
      },
    });
    return res.status(201).json({ rideRequest, pooledWith: null });
  }

  // Found a match: compute both fares via the savings split (Section 6),
  // then create a FORMING pool sized for this Tesla-agnostic step — actual
  // seat capacity is enforced at claim time (Section 7), not here.
  const other = { id: match.id, pickup: { lat: match.pickupLat, lng: match.pickupLng }, dropoff: { lat: match.dropoffLat, lng: match.dropoffLng } };
  const { route, directA, directB } = detourRatios(self, other);
  const soloBackToBack = directA + directB;
  const split = splitPooledFare(directA, directB, route.totalDistance, soloBackToBack);

  await prisma.$transaction(async (tx) => {
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
  });

  return res.status(201).json({
    rideRequest,
    pooledWith: match.id,
    note: "Fares computed as a poolable pair. Call POST /pools/:poolId/claim (once a Tesla/pool is assigned) to actually reserve seats.",
  });
});

// POST /rides/:id/cancel — only valid before STARTED (Section 4).
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

// GET /rides/:id — a passenger can only see their own ride.
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
