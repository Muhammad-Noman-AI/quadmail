// CONTRACT, owned by Track B (Phase 4). Track A calls requireSession on every /api route it adds.
import { HttpError } from "../http";

export interface Session {
  id: string;
  userId: string;
  email: string;
}

/** Returns the session for a valid cookie, or throws HttpError(401). Also enforces the Origin check on mutating requests. */
export async function requireSession(request: Request, env: Env): Promise<Session> {
  void request;
  void env;
  throw new HttpError(401, "Not signed in"); // Implemented in Phase 4.
}
