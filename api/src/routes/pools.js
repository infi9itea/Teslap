const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { idempotent } = require("../middleware/idempotency");

const router = express.Router();

// POST /pools/:poolId/claim
// The endpoint the whole concurrency design (Section 7 of the build plan)
// is built around: two passengers (e.g. Nusrat and Shirin) racing for the
// last seat on the same Tesla must never both succeed.
router.post("/:poolId/claim", requireAuth, idempotent(), async (req, res) => {
  const { poolId } = req.params;
  const { rideRequestId } = req.body;

  if (!rideRequestId) {
    return res.status(400).json({ error: "rideRequestId is required" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Fail fast instead of hanging the passenger's tap if the lock is contended.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`);

      // Lock the pool row (guaranteed to exist once the Tesla is online) — see
      // the plan for why we lock this row rather than a not-yet-created
      // pool-membership row.
      const [pool] = await tx.$queryRaw`
        SELECT p.id, p.occupied_seats AS "occupiedSeats", t.capacity
        FROM pools p
        JOIN teslas t ON t.id = p.tesla_id
        WHERE p.id = ${poolId}
        FOR UPDATE
      `;

      if (!pool) {
        const err = new Error("Pool not found");
        err.status = 404;
        throw err;
      }

      if (pool.occupiedSeats >= pool.capacity) {
        const err = new Error("Seat no longer available");
        err.status = 409;
        throw err;
      }

      await tx.pool.update({
        where: { id: poolId },
        data: { occupiedSeats: { increment: 1 } },
      });

      const updated = await tx.rideRequest.updateMany({
        where: { id: rideRequestId, status: "REQUESTED" },
        data: { poolId, status: "MATCHED", version: { increment: 1 } },
      });

      if (updated.count === 0) {
        // Someone else already matched/cancelled this specific ride request —
        // roll back the seat increment by throwing (transaction aborts).
        const err = new Error("Ride request is no longer claimable");
        err.status = 409;
        throw err;
      }

      await tx.statusHistory.create({
        data: { rideRequestId, fromStatus: "REQUESTED", toStatus: "MATCHED" },
      });

      return tx.rideRequest.findUnique({ where: { id: rideRequestId } });
    });

    return res.status(200).json({ rideRequest: result });
  } catch (err) {
    if (err.code === "55P03") {
      // Postgres lock_not_available — someone else held the row past lock_timeout.
      return res.status(409).json({ error: "Seat claim is contended, try again" });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
