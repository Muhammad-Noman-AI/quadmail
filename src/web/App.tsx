import { useEffect, useState } from "react";

type Health = "checking" | "ok" | "error";

export function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((response) => setHealth(response.ok ? "ok" : "error"))
      .catch(() => setHealth("error"));
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">QuadMail</h1>
        <p className="mt-2 text-sm text-neutral-400">API: {health}</p>
      </div>
    </main>
  );
}
