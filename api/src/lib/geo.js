// Distance and pooling-match math. Straight-line (haversine) distance only —
// deliberately no routing engine, per the plan's "keep geography simple" constraint.
// See Section 5 of the build plan for the reasoning behind detour-ratio matching.

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Straight-line distance in km between two {lat, lng} points. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return EARTH_RADIUS_KM * c;
}

/**
 * Given two ride requests that share (approximately) the same pickup point,
 * find the shorter of the two valid stop orderings and return the distance
 * driven to reach each passenger's dropoff along that route.
 *
 * request shape: { id, pickup: {lat,lng}, dropoff: {lat,lng} }
 *
 * Only handles the 2-passenger, shared-pickup case (matches the PRD's
 * Nusrat/Rafiq scenario). A 3rd passenger or a different-pickup case would
 * need the general TSP-style route search called out in the "at scale" notes.
 */
function shortestPooledRoute(reqA, reqB) {
  const pickup = reqA.pickup; // shared pickup assumed

  // Ordering 1: pickup -> dropoffA -> dropoffB
  const legToA1 = haversineKm(pickup, reqA.dropoff);
  const legAtoB1 = haversineKm(reqA.dropoff, reqB.dropoff);
  const order1 = {
    order: [reqA.id, reqB.id],
    totalDistance: legToA1 + legAtoB1,
    distanceAtDropoff: { [reqA.id]: legToA1, [reqB.id]: legToA1 + legAtoB1 },
  };

  // Ordering 2: pickup -> dropoffB -> dropoffA
  const legToB2 = haversineKm(pickup, reqB.dropoff);
  const legBtoA2 = haversineKm(reqB.dropoff, reqA.dropoff);
  const order2 = {
    order: [reqB.id, reqA.id],
    totalDistance: legToB2 + legBtoA2,
    distanceAtDropoff: { [reqB.id]: legToB2, [reqA.id]: legToB2 + legBtoA2 },
  };

  return order1.totalDistance <= order2.totalDistance ? order1 : order2;
}

/**
 * Returns detour ratios for both passengers if they were pooled, plus the
 * combined route. detourRatio = distance travelled in the pool up to their
 * own dropoff, divided by their direct solo distance.
 */
function detourRatios(reqA, reqB) {
  const directA = haversineKm(reqA.pickup, reqA.dropoff);
  const directB = haversineKm(reqB.pickup, reqB.dropoff);
  const route = shortestPooledRoute(reqA, reqB);

  return {
    route,
    directA,
    directB,
    detourRatioA: route.distanceAtDropoff[reqA.id] / directA,
    detourRatioB: route.distanceAtDropoff[reqB.id] / directB,
  };
}

const MAX_DETOUR_RATIO = 1.3; // documented, tunable — see Section 5 of the plan

/** True if pooling reqA and reqB keeps both passengers' detour under the threshold. */
function isPoolable(reqA, reqB, { maxDetourRatio = MAX_DETOUR_RATIO } = {}) {
  const { detourRatioA, detourRatioB } = detourRatios(reqA, reqB);
  return detourRatioA <= maxDetourRatio && detourRatioB <= maxDetourRatio;
}

module.exports = { haversineKm, shortestPooledRoute, detourRatios, isPoolable, MAX_DETOUR_RATIO };
