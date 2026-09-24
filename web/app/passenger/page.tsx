"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getSession, Session, errorMessage } from "@/lib/api";

// Same coordinates as api/prisma/seed.js, so the demo reproduces the plan's
// worked example (Nusrat + Rafiq pool, detour ratios 1.236 / 1.000).
const AREAS: Record<string, { lat: number; lng: number }> = {
  Banani: { lat: 23.7937, lng: 90.4066 },
  Mohakhali: { lat: 23.764121548646127, lng: 90.39483713960288 },
  "Gulshan 1": { lat: 23.7758931211846, lng: 90.38714301435537 },
};

type RideResult = {
  rideRequest: { id: string; status: string };
  pooledWith: string | null;
  note?: string;
};

type RideDetail = {
  rideRequest: {
    id: string;
    status: string;
    pickupZone: string;
    dropoffZone: string;
    poolId: string | null;
    fare: { totalFarePaisa: number; poolDiscountPaisa: number; baseFarePaisa: number; distanceChargePaisa: number } | null;
  };
};

export default function PassengerPage() {
  const [session, setSessionState] = useState<Session | null>(null);
  const [pickup, setPickup] = useState("Banani");
  const [dropoff, setDropoff] = useState("Mohakhali");
  const [result, setResult] = useState<RideResult | null>(null);
  const [detail, setDetail] = useState<RideDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.push("/login");
      return;
    }
    // Legitimate localStorage hydration on a statically prerendered page —
    // see the equivalent comment in app/page.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionState(s);
  }, [router]);

  async function requestRide() {
    setError(null);
    setLoading(true);
    setDetail(null);
    try {
      const p = AREAS[pickup];
      const d = AREAS[dropoff];
      const res = await api.createRide({
        pickupZone: pickup,
        dropoffZone: dropoff,
        pickupLat: p.lat,
        pickupLng: p.lng,
        dropoffLat: d.lat,
        dropoffLng: d.lng,
      });
      setResult(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshDetail() {
    if (!result) return;
    setError(null);
    try {
      const res = await api.getRide(result.rideRequest.id);
      setDetail(res);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function cancel() {
    if (!result) return;
    setError(null);
    try {
      await api.cancelRide(result.rideRequest.id);
      await refreshDetail();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!session) return null;

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Request a ride</h1>
            <p className="text-sm text-zinc-500">Signed in as {session.user.name}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <label className="block text-sm font-medium text-zinc-700">Pickup</label>
          <select
            value={pickup}
            onChange={(e) => setPickup(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            {Object.keys(AREAS).map((zone) => (
              <option key={zone}>{zone}</option>
            ))}
          </select>

          <label className="mt-4 block text-sm font-medium text-zinc-700">Dropoff</label>
          <select
            value={dropoff}
            onChange={(e) => setDropoff(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            {Object.keys(AREAS)
              .filter((z) => z !== pickup)
              .map((zone) => (
                <option key={zone}>{zone}</option>
              ))}
          </select>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <button
            onClick={requestRide}
            disabled={loading}
            className="mt-6 w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "Requesting..." : "Request ride"}
          </button>
        </div>

        {result && (
          <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-zinc-900">Result</h2>
            <p className="mt-1 text-xs text-zinc-500">Ride ID: {result.rideRequest.id}</p>
            <p className="mt-2 text-sm text-zinc-700">
              {result.pooledWith ? (
                <>
                  Pooled with another passenger (<code className="text-xs">{result.pooledWith}</code>) — fares were
                  recalculated using the detour-savings split.
                </>
              ) : (
                "No pool match yet — solo fare applies until another passenger's request pools with this one."
              )}
            </p>

            <div className="mt-4 flex gap-2">
              <button
                onClick={refreshDetail}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Refresh status &amp; fare
              </button>
              <button
                onClick={cancel}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Cancel ride
              </button>
            </div>

            {detail && (
              <div className="mt-4 rounded-lg bg-zinc-50 p-4 text-sm">
                <p>
                  Status: <span className="font-medium">{detail.rideRequest.status}</span>
                </p>
                <p>
                  Route: {detail.rideRequest.pickupZone} → {detail.rideRequest.dropoffZone}
                </p>
                {detail.rideRequest.fare && (
                  <div className="mt-2 space-y-0.5 text-zinc-600">
                    <p>Base fare: {(detail.rideRequest.fare.baseFarePaisa / 100).toFixed(2)} BDT</p>
                    <p>Distance charge: {(detail.rideRequest.fare.distanceChargePaisa / 100).toFixed(2)} BDT</p>
                    <p>Pool discount: −{(detail.rideRequest.fare.poolDiscountPaisa / 100).toFixed(2)} BDT</p>
                    <p className="font-semibold text-zinc-900">
                      Total: {(detail.rideRequest.fare.totalFarePaisa / 100).toFixed(2)} BDT
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
