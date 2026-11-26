import { z } from "zod";

const csvList = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))
  .pipe(z.array(z.string().min(1)).min(1));

/**
 * Worker vars and secrets. Since the self-setup wizard, most settings may instead live in D1
 * (src/worker/config.ts); a value set here always takes precedence, so existing installations keep working.
 */
export const envSchema = z.object({
  APP_URL: z.url().optional(),
  /** Used by scripts/set-owner-password.ts only. */
  OWNER_EMAIL: z.email().optional(),
  ALLOWED_SENDING_DOMAINS: csvList.optional(),
  DAILY_SEND_LIMIT: z.coerce.number().int().positive().max(100).optional(),
  MAIL_PROVIDER: z.enum(["resend", "cloudflare"]).default("resend"),
  /** Chosen in the Deploy form; unlocks the setup wizard of a fresh installation. */
  SETUP_CODE: z.string().min(8).max(200).optional(),
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  /** Testing only: send Resend API calls to a local mock instead of https://api.resend.com. */
  RESEND_API_BASE: z.url().optional(),
  RESEND_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  /** 32 random bytes, base64. Encrypts TOTP secrets at rest. Required before enabling 2FA. */
  TOTP_ENC_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, "must be 32 bytes, base64-encoded")
    .optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function parseConfig(raw: Record<string, unknown>): AppConfig {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Names only, never values: secrets must not reach logs.
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return result.data;
}
