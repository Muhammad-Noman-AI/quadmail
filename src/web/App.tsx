import { useCallback, useEffect, useState } from "react";
import { api, UNAUTHORIZED_EVENT, type Me } from "./api";
import { ChangePassword } from "./auth/ChangePassword";
import { Login } from "./auth/Login";
import { Shell } from "./shell/Shell";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const loadMe = useCallback(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    loadMe();
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [loadMe]);

  if (me === undefined) return <div className="flex min-h-screen items-center justify-center text-sm text-neutral-500">Loading…</div>;
  if (me === null) return <Login onSignedIn={loadMe} />;
  if (me.mustChangePassword) {
    const signOut = () => api("/api/auth/logout", { method: "POST" }).finally(() => setMe(null));
    return <ChangePassword email={me.email} forced onDone={loadMe} onSignOut={signOut} />;
  }
  return <Shell me={me} onSignedOut={() => setMe(null)} onMeChanged={loadMe} />;
}
