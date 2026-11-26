import { describe, expect, it } from "vitest";
import { parseConfig } from "../shared/env";
import { decryptString, encryptString, fromBase64, toBase64 } from "./auth/crypto";
import { DEFAULT_DAILY_LIMIT, deriveKey, masterKey, resolveConfig } from "./config";

describe("resolveConfig", () => {
  const stored = {
    app_url: "https://quadmail.acme.workers.dev",
    org_name: "Acme",
    sending_domains: "acme.com, Acme.org",
    daily_limit: "50",
    resend_api_key: "re_stored",
    resend_webhook_secret: "whsec_stored",
  };

  it("uses the stored settings on a fresh installation", () => {
    expect(resolveConfig(parseConfig({}), stored)).toEqual({
      appUrl: "https://quadmail.acme.workers.dev",
      orgName: "Acme",
      allowedDomains: ["acme.com", "acme.org"],
      dailyLimit: 50,
      provider: "resend",
      resendApiKey: "re_stored",
      webhookSecret: "whsec_stored",
      resendApiBase: "https://api.resend.com",
      setupState: "complete",
    });
  });

  it("derives the setup state", () => {
    expect(resolveConfig(parseConfig({}), {}, false).setupState).toBe("fresh");
    expect(resolveConfig(parseConfig({}), { setup_state: "in_progress" }, true).setupState).toBe("in_progress");
    // Installations set up by hand have users but no stored state: complete, no wizard.
    expect(resolveConfig(parseConfig({}), {}, true).setupState).toBe("complete");
  });

  it("lets Worker vars and secrets win, field by field (existing installations keep working)", () => {
    const env = parseConfig({ APP_URL: "https://mail.quadgentics.com", ALLOWED_SENDING_DOMAINS: "quadgentics.com", DAILY_SEND_LIMIT: "90", RESEND_API_KEY: "re_env" });
    const config = resolveConfig(env, stored);
    expect(config.appUrl).toBe("https://mail.quadgentics.com");
    expect(config.allowedDomains).toEqual(["quadgentics.com"]);
    expect(config.dailyLimit).toBe(90);
    expect(config.resendApiKey).toBe("re_env");
    expect(config.webhookSecret).toBe("whsec_stored");
  });

  it("falls back to safe defaults and ignores an out-of-range stored limit", () => {
    const config = resolveConfig(parseConfig({}), { daily_limit: "1000" });
    expect(config).toMatchObject({ appUrl: null, allowedDomains: [], dailyLimit: DEFAULT_DAILY_LIMIT, resendApiKey: null });
  });
});

describe("deriveKey", () => {
  const master = toBase64(new Uint8Array(32).fill(9));

  it("is deterministic per purpose and different between purposes", async () => {
    const a = await deriveKey(master, "config");
    expect(await deriveKey(master, "config")).toBe(a);
    expect(await deriveKey(master, "totp")).not.toBe(a);
    expect(fromBase64(a)).toHaveLength(32);
  });

  it("produces a key the AES-GCM helpers accept", async () => {
    const key = await deriveKey(master, "config");
    expect(await decryptString(await encryptString("re_secret", key), key)).toBe("re_secret");
  });
});

/** In-memory stand-in for the parts of R2 that masterKey uses, including the conditional put. */
function fakeBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      objects.set(key, value);
      return {};
    },
  };
}

describe("masterKey", () => {
  it("returns null without creating when asked not to", async () => {
    const bucket = fakeBucket();
    expect(await masterKey(bucket as unknown as R2Bucket, false)).toBeNull();
    expect(bucket.objects.size).toBe(0);
  });

  it("creates one key and keeps it", async () => {
    const bucket = fakeBucket();
    const first = await masterKey(bucket as unknown as R2Bucket, true);
    expect(fromBase64(first!)).toHaveLength(32);
    expect(await masterKey(bucket as unknown as R2Bucket, true)).toBe(first);
  });

  it("two simultaneous creators end up with the same key", async () => {
    const bucket = fakeBucket();
    const [a, b] = await Promise.all([masterKey(bucket as unknown as R2Bucket, true), masterKey(bucket as unknown as R2Bucket, true)]);
    expect(a).toBe(b);
  });
});
