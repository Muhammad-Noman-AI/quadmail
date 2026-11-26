// @vitest-environment jsdom
// Every wizard screen renders without crashing and shows what the user needs at that step.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SetupStatus } from "../../shared/types";
import { Wizard } from "./Wizard";

const base: SetupStatus = {
  state: "in_progress",
  codeConfigured: true,
  orgName: "Acme",
  domain: "acme.com",
  resendConnected: false,
  setupKeyHeld: false,
  sendingReady: false,
  inboundTestAddress: null,
  inboundVerified: false,
};
const render = (status: SetupStatus) => renderToStaticMarkup(<Wizard status={status} onAdminCreated={() => {}} />);

describe("setup wizard screens", () => {
  it("fresh: asks for the setup code, organisation, domain and admin", () => {
    const html = render({ ...base, state: "fresh", orgName: null, domain: null });
    for (const text of ["Setup code", "Organisation name", "Email domain", "Your admin address", "Create organisation"]) expect(html).toContain(text);
  });

  it("fresh without a setup code: explains how to add one instead of a form", () => {
    const html = render({ ...base, state: "fresh", codeConfigured: false });
    expect(html).toContain("SETUP_CODE");
    expect(html).not.toContain("Create organisation");
  });

  it("step 3: asks for a Full access Resend key", () => {
    const html = render(base);
    expect(html).toContain("Connect Resend");
    expect(html).toContain("Full access");
    expect(html).toContain('aria-current="step"');
  });

  it("step 3 again: says why when the held key expired", () => {
    expect(render({ ...base, resendConnected: true })).toContain("only kept for 2 hours");
  });

  it("DNS step while the records load", () => {
    const html = render({ ...base, resendConnected: true, setupKeyHeld: true });
    expect(html).toContain("Add these DNS records for acme.com");
    expect(html).toContain("DNS only");
  });

  it("receiving step after sending is ready", () => {
    const html = render({ ...base, resendConnected: true, sendingReady: true });
    expect(html).toContain("Receive mail");
    expect(html).toContain("Catch-all address");
    expect(html).toContain("Skip for now");
  });

  it("test step once receiving was verified", () => {
    const html = render({ ...base, resendConnected: true, sendingReady: true, inboundVerified: true, inboundTestAddress: "setup-abc123@acme.com" });
    expect(html).toContain("Send a test mail");
  });
});
