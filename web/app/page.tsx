"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSession, clearSession, Session } from "@/lib/api";
import { useRouter } from "next/navigation";

export default function Home() {
  const [session, setSessionState] = useState<Session | null>(null);
  const router = useRouter();

  useEffect(() => {
    // Reading localStorage only works client-side; this page is statically
    // prerendered, so hydrating session state here (rather than via a lazy
    // useState initializer) avoids a server/client markup mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionState(getSession());
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">Dhaka Tesla Pool</h1>
        <p className="mt-1 text-sm text-zinc-500">Pooled rides, split fairly.</p>

        {session ? (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-zinc-600">
              Signed in as <span className="font-medium text-zinc-900">{session.user.name}</span>{" "}
              ({session.user.role.toLowerCase()})
            </p>
            <Link
              href={session.user.role === "DRIVER" ? "/driver" : "/passenger"}
              className="block w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-zinc-800"
            >
              Go to {session.user.role === "DRIVER" ? "driver manifest" : "request a ride"}
            </Link>
            <button
              onClick={() => {
                clearSession();
                setSessionState(null);
                router.refresh();
              }}
              className="block w-full rounded-lg border border-zinc-200 px-4 py-2.5 text-center text-sm font-medium text-zinc-600 hover:bg-zinc-50"
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <Link
              href="/login"
              className="block w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-zinc-800"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="block w-full rounded-lg border border-zinc-200 px-4 py-2.5 text-center text-sm font-medium text-zinc-600 hover:bg-zinc-50"
            >
              Create an account
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
