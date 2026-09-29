const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { applyTransition } = require("../lib/lifecycle");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

// A driver owns one Tesla in this MVP (documented assumption), so "the
// driver's Tesla" means their oldest one.
function findDriverTesla(driverId) {
  return prisma.tesla.findFirst({ where: { driverId }, orderBy: { createdAt: "asc" } });
}

// GET /driver/tesla, the driver's Tesla plus its current pool (if any), so
// the driver UI can load the manifest without a pool ID being pasted in.
router.get("/tesla", requireAuth, requireRole("DRIVER"), asyncHandler(async (req, res) => {
  const tesla = await findDriverTesla(req.user.id);
  if (!tesla) return res.status(404).json({ error: "No Tesla registered for this driver" });

  const currentPool = await prisma.pool.findFirst({
    where: { teslaId: tesla.id, status: { in: ["FORMING", "ACTIVE"] } },
    select: { id: true, status: true, occupiedSeats: true },
  });
  return res.json({ tesla, currentPool });
}));

// PATCH /driver/tesla/status, go online or offline. Riders are only ever
// assigned to ONLINE Teslas (see rides.js), so this is what makes Bullet
// available. Going offline is refused while passengers hold seats, so a
// driver can't strand a matched or in-progress rider. There is a small
// window between the count and the update where a new claim could land;
// accepted for an MVP, a stricter version would lock the pool row here.
router.patch("/tesla/status", requireAuth, requireRole("DRIVER"), asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (status !== "ONLINE" && status !== "OFFLINE") {
    return res.status(400).json({ error: "status must be ONLINE or OFFLINE" });
  }

  const tesla = await findDriverTesla(req.user.id);
  if (!tesla) return res.status(404).json({ error: "No Tesla registered for this driver" });

  if (status === "OFFLINE") {
    const active = await prisma.rideRequest.count({
      where: {
        pool: { teslaId: tesla.id },
        status: { in: ["MATCHED", "DRIVER_ARRIVED", "STARTED"] },
      },
    });
    if (active > 0) {
      return res.status(409).json({ error: "Finish or cancel active rides before going offline" });
    }
  }

  const updated = await prisma.tesla.update({ where: { id: tesla.id }, data: { status } });
  return res.json({ tesla: updated });
}));

// GET /driver/pools/:poolId, the driver's manifest for their vehicle's pool.
// Unlike a passenger, the driver sees everyone in the pool, not just themselves.
router.get("/pools/:poolId", requireAuth, requireRole("DRIVER"), asyncHandler(async (req, res) => {
  const pool = await prisma.pool.findUnique({
    where: { id: req.params.poolId },
    include: {
      tesla: true,
      rideRequests: { include: { fare: true, passenger: { select: { id: true, name: true, phone: true } } } },
    },
  });
  if (!pool) return res.status(404).json({ error: "Not found" });
  if (pool.tesla.driverId !== req.user.id) {
    return res.status(403).json({ error: "Not your Tesla" });
  }
  return res.json({ pool });
}));

// If completing this ride leaves every ride request in its pool in a
// terminal state (COMPLETED or CANCELLED), mark the pool itself COMPLETED
// too, rather than leaving pools.status stuck on FORMING forever.
async function maybeCompletePool(tx, poolId) {
  if (!poolId) return;
  const siblings = await tx.rideRequest.findMany({ where: { poolId }, select: { status: true } });
  const allTerminal = siblings.length > 0 && siblings.every((r) => r.status === "COMPLETED" || r.status === "CANCELLED");
  if (allTerminal) {
    await tx.pool.update({ where: { id: poolId }, data: { status: "COMPLETED", completedAt: new Date() } });
  }
}

// Shared handler for the three sequential driver-side transitions.
function transitionHandler(from, to) {
  return asyncHandler(async (req, res) => {
    const { id } = req.params;
    try {
      const current = await prisma.rideRequest.findUnique({ where: { id }, include: { pool: { include: { tesla: true } } } });
      if (!current) return res.status(404).json({ error: "Not found" });
      if (current.pool?.tesla?.driverId !== req.user.id) {
        return res.status(403).json({ error: "Not your Tesla" });
      }
      await prisma.$transaction(async (tx) => {
        await applyTransition(tx, id, from, to);
        if (to === "COMPLETED") {
          await maybeCompletePool(tx, current.poolId);
        }
      });
      return res.status(200).json({ status: to });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err; // let asyncHandler/central error middleware handle anything unexpected
    }
  });
}

router.post("/rides/:id/arrive", requireAuth, requireRole("DRIVER"), transitionHandler("MATCHED", "DRIVER_ARRIVED"));
router.post("/rides/:id/start", requireAuth, requireRole("DRIVER"), transitionHandler("DRIVER_ARRIVED", "STARTED"));
router.post("/rides/:id/complete", requireAuth, requireRole("DRIVER"), transitionHandler("STARTED", "COMPLETED"));

module.exports = router;
