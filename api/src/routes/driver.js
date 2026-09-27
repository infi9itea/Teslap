const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { applyTransition } = require("../lib/lifecycle");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

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
