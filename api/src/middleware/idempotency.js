const crypto = require("crypto");
const prisma = require("../lib/prisma");

// Standard idempotency-key pattern (as used by Stripe et al.): client sends a
// unique key on a mutating request; a retried request with the same key
// returns the original result instead of re-running the side effect. See
// Section 7 of the build plan for why this matters specifically on the
// seat-claim endpoint.
function idempotent() {
  return async (req, res, next) => {
    const key = req.headers["idempotency-key"];
    if (!key) {
      return res.status(400).json({ error: "Idempotency-Key header is required" });
    }

    const requestHash = crypto
      .createHash("sha256")
      .update(req.method + req.originalUrl + JSON.stringify(req.body || {}))
      .digest("hex");

    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return res.status(422).json({
          error: "Idempotency-Key was already used with a different request body",
        });
      }
      return res.status(existing.statusCode || 200).json(existing.responseBody);
    }

    // Capture the response so we can store it once the handler finishes.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      prisma.idempotencyKey
        .create({
          data: { key, endpoint: req.originalUrl, requestHash, responseBody: body, statusCode: res.statusCode },
        })
        .catch((err) => {
          // Don't fail the request over a bookkeeping write; log and move on.
          console.error("Failed to persist idempotency key:", err.message);
        });
      return originalJson(body);
    };

    next();
  };
}

module.exports = { idempotent };
