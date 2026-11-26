import type { Role } from "../shared/types";

// Thin JSON client for /api. Same-origin requests carry the session cookie and an Origin header.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = "qm:unauthorized";

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/login")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(response.status, typeof data.error === "string" ? data.error : "Request failed", data);
  }
  return data as T;
}

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  /** Set when an admin created the account or reset the password. */
  mustChangePassword: boolean;
  totpEnabled: boolean;
}

export interface Label {
  id: string;
  name: string;
  color: string | null;
}
