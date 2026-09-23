const { PrismaClient } = require("@prisma/client");

// Avoid exhausting DB connections from hot-reload in dev.
const globalForPrisma = globalThis;

const prisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
