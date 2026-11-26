// Version check for admins: this build's version vs the latest release of the upstream repository
// (upstream.json). Installations made with the Deploy button update with the "Update QuadMail" workflow.
import upstream from "../../../upstream.json";
import { APP_VERSION, compareVersions } from "../../shared/version";
import { secured } from "../auth/respond";
import { requireAdmin } from "../auth/session";
import { json } from "../http";
import type { Route } from "../router";

const CACHE_MS = 6 * 60 * 60 * 1000;
let cache: { at: number; latest: string | null } | null = null;

async function latestRelease(repo: string): Promise<string | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.latest;
  let latest: string | null = null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "QuadMail-Version-Check" },
    });
    if (response.ok) {
      const tag = ((await response.json()) as { tag_name?: unknown }).tag_name;
      latest = typeof tag === "string" ? tag.replace(/^v/, "") : null;
    }
  } catch {
    // Offline or rate-limited: no update information, not an error for the admin.
  }
  cache = { at: Date.now(), latest };
  return latest;
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/version",
    handler: async ({ request, env }) => {
      await requireAdmin(request, env);
      const repo = /^[\w.-]+\/[\w.-]+$/.test(upstream.repo) ? upstream.repo : null;
      const latest = repo ? await latestRelease(repo) : null;
      return json({
        version: APP_VERSION,
        latest,
        updateAvailable: !!latest && APP_VERSION !== "dev" && compareVersions(latest, APP_VERSION) > 0,
        repo,
      });
    },
  },
];

export const versionRoutes: Route[] = routes.map(secured);
