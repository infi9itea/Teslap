const { haversineKm, isPoolable, detourRatios, MAX_DETOUR_RATIO } = require("../lib/geo");

// Coordinates from prisma/seed.js — constructed so direct distances are
// exactly 3.5km (Mohakhali) and 2.8km (Gulshan 1) from Banani, matching the
// plan's worked example.
const BANANI = { lat: 23.7937, lng: 90.4066 };
const MOHAKHALI = { lat: 23.764121548646127, lng: 90.39483713960288 };
const GULSHAN1 = { lat: 23.7758931211846, lng: 90.38714301435537 };

describe("haversineKm", () => {
  it("returns ~0 for identical points", () => {
    expect(haversineKm(BANANI, BANANI)).toBeCloseTo(0, 3);
  });
});

describe("isPoolable — Nusrat + Rafiq (the PRD's pooling scenario)", () => {
  const nusrat = { id: "nusrat", pickup: BANANI, dropoff: MOHAKHALI };
  const rafiq = { id: "rafiq", pickup: BANANI, dropoff: GULSHAN1 };

  it("pools within the default detour ratio threshold", () => {
    expect(isPoolable(nusrat, rafiq)).toBe(true);
  });

  it("both detour ratios stay under the documented 1.3 threshold", () => {
    const { detourRatioA, detourRatioB } = detourRatios(nusrat, rafiq);
    expect(detourRatioA).toBeLessThanOrEqual(MAX_DETOUR_RATIO);
    expect(detourRatioB).toBeLessThanOrEqual(MAX_DETOUR_RATIO);
  });

  it("rejects a pairing whose detour ratio exceeds a stricter threshold", () => {
    // A much stricter cap should reject the same pairing — proves the
    // threshold is actually doing something, not just always passing.
    expect(isPoolable(nusrat, rafiq, { maxDetourRatio: 1.2 })).toBe(false);
  });
});

describe("isPoolable — a genuinely incompatible pairing", () => {
  it("rejects two passengers travelling in roughly opposite directions", () => {
    // Same distance as Rafiq's trip (2.8km) but on the opposite bearing from
    // Banani, so pooling would roughly double the combined route.
    const OPPOSITE_DIRECTION = { lat: 23.817362119006596, lng: 90.41601414424436 };
    const passengerA = { id: "a", pickup: BANANI, dropoff: MOHAKHALI };
    const passengerB = { id: "b", pickup: BANANI, dropoff: OPPOSITE_DIRECTION };
    expect(isPoolable(passengerA, passengerB)).toBe(false);
  });
});
