// Seeds Jashim/Bullet, Nusrat, Rafiq, Shirin with the Banani/Mohakhali/Gulshan-1
// trip data used throughout the build plan, so the fare and matching examples
// there are reproducible against this exact data.
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

// Coordinates chosen (via prisma/README's bearing/distance construction) so that:
//   - direct Banani->Mohakhali  = 3.500km  (Nusrat, matches the plan's worked example)
//   - direct Banani->Gulshan 1  = 2.800km  (Rafiq, matches the plan's worked example)
//   - pooled route total        = 4.325km  (both legs share the Banani pickup)
//   - detour ratio: Nusrat 1.236, Rafiq 1.000 — both clear the 1.3 threshold from Section 5
// Verified with `node -e` against src/lib/geo.js — see git history / build plan Section 6.
const AREAS = {
  banani: { lat: 23.7937, lng: 90.4066 },
  mohakhali: { lat: 23.764121548646127, lng: 90.39483713960288 },
  gulshan1: { lat: 23.7758931211846, lng: 90.38714301435537 },
};

async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);

  const jashim = await prisma.user.upsert({
    where: { phone: "01700000001" },
    update: {},
    create: { name: "Jashim", phone: "01700000001", role: "DRIVER", passwordHash },
  });

  const [nusrat, rafiq, shirin] = await Promise.all([
    prisma.user.upsert({
      where: { phone: "01700000002" },
      update: {},
      create: { name: "Nusrat", phone: "01700000002", role: "PASSENGER", passwordHash },
    }),
    prisma.user.upsert({
      where: { phone: "01700000003" },
      update: {},
      create: { name: "Rafiq", phone: "01700000003", role: "PASSENGER", passwordHash },
    }),
    prisma.user.upsert({
      where: { phone: "01700000004" },
      update: {},
      create: { name: "Shirin", phone: "01700000004", role: "PASSENGER", passwordHash },
    }),
  ]);

  const bullet = await prisma.tesla.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      driverId: jashim.id,
      plateNumber: "DHK-BULLET-01",
      capacity: 3,
      status: "ONLINE",
    },
  });

  console.log("Seeded:");
  console.log({ jashim: jashim.id, nusrat: nusrat.id, rafiq: rafiq.id, shirin: shirin.id, bullet: bullet.id });
  console.log("Areas used for the fare/matching worked example:", AREAS);
  console.log("Demo login: phone as above, password 'password123' for all users.");
  console.log(
    "\nTo reproduce the plan's worked example: log in as Nusrat, POST /rides with " +
      "the mohakhali coords above as dropoff, then log in as Rafiq and POST /rides " +
      "with the gulshan1 coords as dropoff — the second call should report " +
      "pooledWith: <Nusrat's ride id>, and each ride's /rides/:id fare should match " +
      "the numbers in Section 6 of the build plan (Nusrat 4922 paisa, Rafiq 4538 paisa)."
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
