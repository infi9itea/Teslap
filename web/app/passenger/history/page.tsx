"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, getSession, Session, errorMessage } from "@/lib/api";

type HistoryRide = {
  id: string;
  status: string;
  pickupZone: string;
  dropoffZone: string;
  requestedAt: string;
  fare: { totalFarePaisa: number } | null;
};

export default function RideHistoryPage() {
  const [session, setSessionState] = useState<Session | null>(null);
  const [rides, setRides] = useState<HistoryRide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.push("/login");
      return;
    }
    // Legitimate localStorage hydration on a statically prerendered page,
    // see the equivalent comment in app/page.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionState(s);

    api
      .listRides()
      .then((res) => setRides(res.rideRequests))
      .catch((err) => setError(errorMessage(err)));
  }, [router]);

  if (!session) return null;

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Ride history</h1>
            <p className="text-sm text-zinc-500">Signed in as {session.user.name}</p>
          </div>
          <Link href="/passenger" className="text-sm font-medium text-zinc-700 underline">
            Request a ride
          </Link>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && rides === null && <p className="text-sm text-zinc-500">Loading...</p>}
        {rides !== null && rides.length === 0 && (
          <p className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            No rides yet. Request one to see it here.
          </p>
        )}

        {rides !== null && rides.length > 0 && (
          <div className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-white px-6 shadow-sm">
            {rides.map((ride) => (
              <div key={ride.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-900">
                    {ride.pickupZone} → {ride.dropoffZone}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {new Date(ride.requestedAt).toLocaleString()} · {ride.status}
                  </p>
                </div>
                <p className="text-sm font-semibold text-zinc-900">
                  {ride.fare ? `${(ride.fare.totalFarePaisa / 100).toFixed(2)} BDT` : "-"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
