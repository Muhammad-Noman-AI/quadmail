// Runs before the generic `pnpm run deploy`. That script is meant for the Deploy to Cloudflare button
// (Workers Builds sets CI / WORKERS_CI). Run by hand on the Quadgentics account it would replace the
// production Worker "quadmail" with an unconfigured one, so it stops unless asked explicitly.
if (process.env.WORKERS_CI || process.env.CI || process.env.QM_GENERIC_DEPLOY === "1") process.exit(0);
console.error(
  [
    "Refusing a generic deploy from this machine.",
    "  Quadgentics production:  pnpm deploy:quadgentics",
    "  A generic installation:  set QM_GENERIC_DEPLOY=1, then run pnpm run deploy",
  ].join("\n"),
);
process.exit(1);
