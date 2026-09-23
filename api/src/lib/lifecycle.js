// Single source of truth for the ride state machine (Section 4 of the build plan).
// Every transition made through applyTransition() is written to status_history.

const VALID_TRANSITIONS = {
  REQUESTED: ["MATCHED", "CANCELLED"],
  MATCHED: ["DRIVER_ARRIVED", "CANCELLED"],
  DRIVER_ARRIVED: ["STARTED", "CANCELLED"],
  STARTED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

function canTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

/** Runs a validated transition + status_history write inside an existing Prisma transaction. */
async function applyTransition(tx, rideRequestId, from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`Invalid transition ${from} -> ${to}`);
    err.status = 409;
    throw err;
  }

  const updated = await tx.rideRequest.updateMany({
    where: { id: rideRequestId, status: from },
    data: { status: to, version: { increment: 1 } },
  });

  if (updated.count === 0) {
    const err = new Error("Ride request status changed concurrently, retry");
    err.status = 409;
    throw err;
  }

  await tx.statusHistory.create({
    data: { rideRequestId, fromStatus: from, toStatus: to },
  });
}

module.exports = { VALID_TRANSITIONS, canTransition, applyTransition };
