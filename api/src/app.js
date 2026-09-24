const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const rideRoutes = require("./routes/rides");
const poolRoutes = require("./routes/pools");
const driverRoutes = require("./routes/driver");

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  app.use("/auth", authRoutes);
  app.use("/rides", rideRoutes);
  app.use("/pools", poolRoutes);
  app.use("/driver", driverRoutes);

  // Last-resort error handler
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  });

  return app;
}

module.exports = { createApp };
