import { useCallback, useEffect, useState } from "react";
import type { SetupStatus } from "../shared/types";
import { api, UNAUTHORIZED_EVENT, type Me } from "./api";
import { ChangePassword } from "./auth/ChangePassword";
import { Login } from "./auth/Login";
import { Wizard } from "./setup/Wizard";
import { Shell } from "./shell/Shell";

const COMPLETE: SetupStatus = {
  state: "complete",
  codeConfigured: false,
  orgName: null,
  domain: null,
  resendConnected: false,
  setupKeyHeld: false,
  sendingReady: false,
  inboundTestAddress: null,
  inboundVerified: false,
};

export function App() {
  const [setup, setSetup] = useState<SetupStatus | undefined>(undefined);
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  // Setup state first: a fresh installation shows the wizard instead of a login nobody can pass.
  const load = useCallback(
    () =>
      api<SetupStatus>("/api/setup/status")
        .catch(() => COMPLETE)
        .then(async (status) => {
          if (status.state !== "fresh") setMe(await api<Me>("/api/me").catch(() => null));
          setSetup({ ...COMPLETE, ...status });
        }),
    [],
  );

  useEffect(() => {
    void load();
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [load]);

  const loadMe = useCallback(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  if (setup === undefined || (setup.state !== "fresh" && me === undefined)) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-neutral-500">Loading…</div>;
  }
  if (setup.state === "fresh") return <Wizard status={setup} onAdminCreated={() => void load()} />;
  if (setup.state === "in_progress") {
    if (!me) return <Login onSignedIn={() => void load()} notice="Setup is not finished yet. Sign in as the admin to continue." />;
    if (me.role === "admin") return <Wizard key={setup.orgName ?? "setup"} status={setup} onAdminCreated={() => void load()} />;
  }
  if (me === null || me === undefined) return <Login onSignedIn={loadMe} />;
  if (me.mustChangePassword) {
    const signOut = () => api("/api/auth/logout", { method: "POST" }).finally(() => setMe(null));
    return <ChangePassword email={me.email} forced onDone={loadMe} onSignOut={signOut} />;
  }
  return <Shell me={me} onSignedOut={() => setMe(null)} onMeChanged={loadMe} />;
}
