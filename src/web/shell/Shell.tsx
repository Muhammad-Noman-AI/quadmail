import { useCallback, useEffect, useState } from "react";
import type { MessageSummary } from "../../shared/types";
import { api, type Label, type Me } from "../api";
import { processPending } from "../mail/parse";
import { Reader } from "../reader/Reader";
import { navigate, useRoute, viewHash } from "../route";
import { applyPatch, patchMessages, type MessagePatch } from "./actions";
import { MessageList } from "./MessageList";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";

interface Page {
  items: MessageSummary[];
  nextCursor: string | null;
}

export function Shell({ me, onSignedOut, onMeChanged }: { me: Me; onSignedOut: () => void; onMeChanged: () => void }) {
  const route = useRoute();
  const { view, messageId } = route;
  const [labels, setLabels] = useState<Label[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [page, setPage] = useState<Page>({ items: [], nextCursor: null });
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchText, setSearchText] = useState(view.kind === "search" ? view.query : "");
  const viewKey = viewHash(view);

  const refreshMeta = useCallback(() => {
    api<{ items: Label[] }>("/api/labels").then((r) => setLabels(r.items)).catch(() => {});
    api<Record<string, number>>("/api/counts").then(setCounts).catch(() => {});
  }, []);

  const listUrl = useCallback(
    (cursor?: string | null) => {
      if (view.kind === "search") return `/api/search?q=${encodeURIComponent(view.query)}`;
      const params = new URLSearchParams({ limit: "50" });
      if (view.kind === "folder") params.set("folder", view.folder);
      if (view.kind === "starred") params.set("starred", "1");
      if (view.kind === "label") params.set("label", view.labelId);
      if (cursor) params.set("cursor", cursor);
      return `/api/messages?${params.toString()}`;
    },
    // viewKey captures every field of `view` that affects the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewKey],
  );

  const reload = useCallback(() => {
    if (view.kind === "settings") return;
    const url = listUrl();
    api<Page>(url)
      .then((result) => setPage({ items: result.items, nextCursor: result.nextCursor ?? null }))
      .catch((err: Error) => setNotice(err.message))
      .finally(() => setLoadedUrl(url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUrl]);

  useEffect(() => {
    refreshMeta();
    // Index anything the Worker stored but the browser has not parsed yet. Best effort.
    processPending().catch(() => {});
  }, [refreshMeta]);

  useEffect(reload, [reload]);

  async function loadMore() {
    if (!page.nextCursor) return;
    const result = await api<Page>(listUrl(page.nextCursor));
    setPage((current) => ({ items: [...current.items, ...result.items], nextCursor: result.nextCursor }));
  }

  /** Optimistic: update the list now, roll back if the server refuses. */
  async function act(ids: string[], patch: MessagePatch) {
    const before = page.items;
    const leavesView =
      (patch.folder !== undefined && view.kind === "folder" && patch.folder !== view.folder) ||
      (patch.isStarred === false && view.kind === "starred") ||
      (view.kind === "label" && patch.removeLabels?.includes(view.labelId));
    setPage((current) => ({
      ...current,
      items: leavesView ? current.items.filter((m) => !ids.includes(m.id)) : current.items.map((m) => (ids.includes(m.id) ? applyPatch(m, patch) : m)),
    }));
    if (leavesView && messageId && ids.includes(messageId)) navigate(viewHash(view));
    try {
      await patchMessages(ids, patch);
      refreshMeta();
    } catch (err) {
      setPage((current) => ({ ...current, items: before }));
      setNotice(err instanceof Error ? err.message : "Action failed");
    }
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    onSignedOut();
  }

  // Loading until the response for the current list URL has arrived.
  const loading = view.kind !== "settings" && loadedUrl !== listUrl();
  const selected = page.items.find((m) => m.id === messageId) ?? null;

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <a href="#/inbox" className="text-lg font-semibold">
          QuadMail
        </a>
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (searchText.trim()) navigate(viewHash({ kind: "search", query: searchText.trim() }));
          }}
        >
          <input
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search mail (from: to: has:attachment before:2026-01-01 after: in:archive)"
            className="w-full max-w-2xl rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-800 dark:bg-neutral-900"
          />
        </form>
        <span className="hidden text-sm text-neutral-500 sm:inline">{me.email}</span>
        <button onClick={signOut} className="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800">
          Sign out
        </button>
      </header>

      {notice && (
        <div role="alert" className="flex items-center justify-between bg-amber-50 px-4 py-1.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {notice}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Sidebar view={view} labels={labels} counts={counts} onLabelsChanged={refreshMeta} className={messageId ? "hidden lg:flex" : "hidden md:flex"} />
        {view.kind === "settings" ? (
          <Settings me={me} onChanged={onMeChanged} onSignedOut={onSignedOut} />
        ) : (
          <>
            <MessageList
              view={view}
              items={loading ? [] : page.items}
              loading={loading}
              hasMore={page.nextCursor !== null}
              selectedId={messageId}
              labels={labels}
              onLoadMore={loadMore}
              onAct={act}
              onRefresh={reload}
              className={messageId ? "hidden md:flex" : "flex"}
            />
            {messageId ? (
              <Reader key={messageId} messageId={messageId} summary={selected} view={view} labels={labels} onAct={act} onNotice={setNotice} />
            ) : (
              <div className="hidden flex-1 items-center justify-center text-sm text-neutral-400 md:flex">Select a message to read it.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
