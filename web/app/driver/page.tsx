"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getSession, Session, errorMessage } from "@/lib/api";

type RideRow = {
  id: string;
  status: string;
  passenger: { name: string; phone: string };
  fare: { totalFarePaisa: number } | null;
};

type Manifest = {
  pool: {
    id: string;
    status: string;
    occupiedSeats: number;
    tesla: { plateNumber: string; capacity: number };
    rideRequests: RideRow[];
  };
};

const NEXT_ACTION: Record<string, { label: string; action: keyof typeof api } | null> = {
  MATCHED: { label: "Mark driver arrived", action: "driverArrive" },
  DRIVER_ARRIVED: { label: "Start ride", action: "driverStart" },
  STARTED: { label: "Complete ride", action: "driverComplete" },
  COMPLETED: null,
  CANCELLED: null,
  REQUESTED: null,
};

export default function DriverPage() {
  const [session, setSessionState] = useState<Session | null>(null);
  const [poolId, setPoolId] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
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

  async function loadManifest() {
    if (!poolId) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.driverManifest(poolId);
      setManifest(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function runAction(rideId: string, action: keyof typeof api) {
    setError(null);
    try {
      // @ts-expect-error — action is always one of the driver transition fns
      await api[action](rideId);
      await loadManifest();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!session) return null;

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-semibold text-zinc-900">Driver manifest</h1>
        <p className="text-sm text-zinc-500">Signed in as {session.user.name}</p>

        <div className="mt-6 flex gap-2">
          <input
            value={poolId}
            onChange={(e) => setPoolId(e.target.value)}
            placeholder="Pool ID"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
          <button
            onClick={loadManifest}
            disabled={loading}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "Loading..." : "Load"}
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        {manifest && (
          <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-900">
                {manifest.pool.tesla.plateNumber} — {manifest.pool.occupiedSeats}/{manifest.pool.tesla.capacity} seats
              </h2>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                {manifest.pool.status}
              </span>
            </div>

            <div className="mt-4 divide-y divide-zinc-100">
              {manifest.pool.rideRequests.map((ride) => {
                const next = NEXT_ACTION[ride.status];
                return (
                  <div key={ride.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium text-zinc-900">{ride.passenger.name}</p>
                      <p className="text-xs text-zinc-500">
                        {ride.status}
                        {ride.fare ? ` · ${(ride.fare.totalFarePaisa / 100).toFixed(2)} BDT` : ""}
                      </p>
                    </div>
                    {next && (
                      <button
                        onClick={() => runAction(ride.id, next.action)}
                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        {next.label}
                      </button>
                    )}
                  </div>
                );
              })}
              {manifest.pool.rideRequests.length === 0 && (
                <p className="py-3 text-sm text-zinc-500">No passengers in this pool yet.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
