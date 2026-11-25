import { z } from "zod";

const csvList = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))
  .pipe(z.array(z.string().min(1)).min(1));

/** Worker configuration (vars + secrets). Parsed once per request so a bad deploy fails loudly. */
export const envSchema = z.object({
  APP_URL: z.url(),
  OWNER_EMAIL: z.email(),
  ALLOWED_SENDING_DOMAINS: csvList,
  DAILY_SEND_LIMIT: z.coerce.number().int().positive().max(100),
  MAIL_PROVIDER: z.enum(["resend", "cloudflare"]),
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
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
