const { soloFarePaisa, splitPooledFare } = require("../lib/fare");

describe("soloFarePaisa", () => {
  it("matches the plan's worked example for Nusrat (3.5km)", () => {
    expect(soloFarePaisa(3.5)).toBe(5800);
  });

  it("matches the plan's worked example for Rafiq (2.8km)", () => {
    expect(soloFarePaisa(2.8)).toBe(5240);
  });
});

describe("splitPooledFare", () => {
  // pooledTotalKm (4.325) is the actual shortest-route distance for the seed
  // coordinates in prisma/seed.js — computed by src/lib/geo.js, not assumed.
  it("splits the saving proportionally to direct distance, per the plan's example", () => {
    const directA = 3.5; // Nusrat
    const directB = 2.8; // Rafiq
    const pooledTotalKm = 4.325243335736209;
    const soloBackToBackKm = 6.3;

    const split = splitPooledFare(directA, directB, pooledTotalKm, soloBackToBackKm);

    expect(split.totalSavingPaisa).toBe(1580);
    expect(split.passengerA.totalFarePaisa).toBe(4922); // Nusrat
    expect(split.passengerB.totalFarePaisa).toBe(4538); // Rafiq
  });

  it("never produces a combined fare greater than riding solo", () => {
    const split = splitPooledFare(3.5, 2.8, 4.325243335736209, 6.3);
    const combinedPooled = split.passengerA.totalFarePaisa + split.passengerB.totalFarePaisa;
    const combinedSolo = soloFarePaisa(3.5) + soloFarePaisa(2.8);
    expect(combinedPooled).toBeLessThanOrEqual(combinedSolo);
  });

  it("produces zero discount when pooling saves no distance", () => {
    const split = splitPooledFare(3.5, 2.8, 6.3, 6.3);
    expect(split.totalSavingPaisa).toBe(0);
    expect(split.passengerA.poolDiscountPaisa).toBe(0);
    expect(split.passengerB.poolDiscountPaisa).toBe(0);
  });
});
