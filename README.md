# QuadMail

Self-owned email for `quadgentics.com`, running entirely on Cloudflare's free tier.

- **Receiving:** Cloudflare Email Routing (catch-all) → this Worker's `email()` handler → raw mail in R2, metadata in D1.
- **Webmail:** React single-page app served as Worker static assets; API at `/api/*` in the same Worker.
- **Parsing:** done in the browser with `postal-mime`, so the Worker stays inside the 10 ms free CPU limit.
- **Sending:** Resend API, behind a swappable provider interface.

See [docs/PLAN.md](docs/PLAN.md) for verified limits and phases, and `docs/SETUP.md` (Phase 7) for the human checklist.

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in values
pnpm cf-typegen                  # generate Worker types from wrangler.jsonc
pnpm dev                         # http://localhost:5173
pnpm check                       # typecheck + lint + tests
```

## Status

Phase 1 (scaffold) done. Next: Phase 2 (D1 schema, R2 bucket).
