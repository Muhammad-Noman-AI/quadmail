// Track A (Phase 3): Email Routing handler. Must stay well under the 10 ms CPU limit: no MIME parsing here.
export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  void message;
  void env;
  void ctx;
}
