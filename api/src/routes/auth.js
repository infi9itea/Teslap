const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

const router = express.Router();

router.post("/register", async (req, res) => {
  const { name, phone, password, role } = req.body;
  if (!name || !phone || !password || !["PASSENGER", "DRIVER"].includes(role)) {
    return res.status(400).json({ error: "name, phone, password, role (PASSENGER|DRIVER) are required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const user = await prisma.user.create({
      data: { name, phone, passwordHash, role },
    });
    return res.status(201).json({ id: user.id, name: user.name, role: user.role });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Phone already registered" });
    console.error(err);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid phone or password" });
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "12h" });
  return res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

module.exports = router;
