// Fare math. Everything in integer paisa (1 BDT = 100 paisa) — never Float/Decimal
// for money, to avoid rounding drift. See Section 6 of the build plan.

const BASE_FARE_PAISA = 3000; // 30.00 BDT
const DISTANCE_RATE_PAISA_PER_KM = 800; // 8.00 BDT/km

/** Solo fare for a direct-distance trip, no pooling. */
function soloFarePaisa(distanceKm) {
  return BASE_FARE_PAISA + Math.round(DISTANCE_RATE_PAISA_PER_KM * distanceKm);
}

/**
 * Split a pooled trip's fare between two passengers.
 *
 * poolDiscount is each passenger's proportional share of the ACTUAL distance
 * saved by pooling (not a flat percentage) — the saving is split in proportion
 * to each passenger's direct distance, i.e. their share of the demand they
 * place on the vehicle. See Section 6 of the plan for the worked example and
 * the reasoning (carpooling fare-splitting literature) behind this choice.
 *
 * @param {number} directKmA - passenger A's direct solo distance in km
 * @param {number} directKmB - passenger B's direct solo distance in km
 * @param {number} pooledTotalKm - total distance driven for the pooled route
 * @param {number} soloBackToBackKm - distance if both were driven solo, back to back
 *   (i.e. directKmA + directKmB, or a caller-supplied more precise figure)
 */
function splitPooledFare(directKmA, directKmB, pooledTotalKm, soloBackToBackKm) {
  const soloFareA = soloFarePaisa(directKmA);
  const soloFareB = soloFarePaisa(directKmB);

  const totalSavingKm = Math.max(0, soloBackToBackKm - pooledTotalKm);
  const totalSavingPaisa = Math.round(totalSavingKm * DISTANCE_RATE_PAISA_PER_KM);

  const shareA = directKmA / (directKmA + directKmB);
  const shareB = 1 - shareA;

  const discountA = Math.round(totalSavingPaisa * shareA);
  const discountB = totalSavingPaisa - discountA; // remainder avoids rounding leaks

  return {
    passengerA: {
      baseFarePaisa: BASE_FARE_PAISA,
      distanceChargePaisa: soloFareA - BASE_FARE_PAISA,
      poolDiscountPaisa: discountA,
      totalFarePaisa: soloFareA - discountA,
    },
    passengerB: {
      baseFarePaisa: BASE_FARE_PAISA,
      distanceChargePaisa: soloFareB - BASE_FARE_PAISA,
      poolDiscountPaisa: discountB,
      totalFarePaisa: soloFareB - discountB,
    },
    totalSavingPaisa,
  };
}

module.exports = { BASE_FARE_PAISA, DISTANCE_RATE_PAISA_PER_KM, soloFarePaisa, splitPooledFare };
