// Thin fetch wrapper around the API in ../../api. Keeps the JWT in
// localStorage (fine for an MVP demo — see the build plan's auth section for
// what a production hardening pass would change).

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000";

export type Session = { token: string; user: { id: string; name: string; role: "PASSENGER" | "DRIVER" } };

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem("tesla_pool_session");
  return raw ? JSON.parse(raw) : null;
}

export function setSession(session: Session) {
  window.localStorage.setItem("tesla_pool_session", JSON.stringify(session));
}

export function clearSession() {
  window.localStorage.removeItem("tesla_pool_session");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function request(path: string, options: RequestInit = {}) {
  const session = getSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

export const api = {
  register: (data: { name: string; phone: string; password: string; role: "PASSENGER" | "DRIVER" }) =>
    request("/auth/register", { method: "POST", body: JSON.stringify(data) }),

  login: (data: { phone: string; password: string }) =>
    request("/auth/login", { method: "POST", body: JSON.stringify(data) }),

  createRide: (data: {
    pickupZone: string;
    dropoffZone: string;
    pickupLat: number;
    pickupLng: number;
    dropoffLat: number;
    dropoffLng: number;
  }) => request("/rides", { method: "POST", body: JSON.stringify(data) }),

  getRide: (id: string) => request(`/rides/${id}`),

  cancelRide: (id: string) => request(`/rides/${id}/cancel`, { method: "POST" }),

  claimSeat: (poolId: string, rideRequestId: string, idempotencyKey: string) =>
    request(`/pools/${poolId}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ rideRequestId }),
    }),

  driverManifest: (poolId: string) => request(`/driver/pools/${poolId}`),

  driverArrive: (rideId: string) => request(`/driver/rides/${rideId}/arrive`, { method: "POST" }),
  driverStart: (rideId: string) => request(`/driver/rides/${rideId}/start`, { method: "POST" }),
  driverComplete: (rideId: string) => request(`/driver/rides/${rideId}/complete`, { method: "POST" }),
};
