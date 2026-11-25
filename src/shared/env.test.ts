import { describe, expect, it } from "vitest";
import { parseConfig } from "./env";

const valid = {
  APP_URL: "https://mail.quadgentics.com",
  OWNER_EMAIL: "noman@quadgentics.com",
  ALLOWED_SENDING_DOMAINS: "quadgentics.com, Example.org",
  DAILY_SEND_LIMIT: "90",
  MAIL_PROVIDER: "resend",
};

describe("parseConfig", () => {
  it("parses and normalises valid config", () => {
    const config = parseConfig(valid);
    expect(config.ALLOWED_SENDING_DOMAINS).toEqual(["quadgentics.com", "example.org"]);
    expect(config.DAILY_SEND_LIMIT).toBe(90);
  });

  it("rejects a send limit above the Resend free daily cap", () => {
    expect(() => parseConfig({ ...valid, DAILY_SEND_LIMIT: "500" })).toThrow(/DAILY_SEND_LIMIT/);
  });

  it("names bad fields without echoing secret values", () => {
    const secret = "not-a-resend-key-SECRET";
    let message = "";
    try {
      parseConfig({ ...valid, RESEND_API_KEY: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("RESEND_API_KEY");
    expect(message).not.toContain(secret);
  });
});
