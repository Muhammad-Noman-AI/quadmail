import { useState } from "react";
import type { Folder, MessageSummary } from "../../shared/types";
import type { Label } from "../api";
import { displayAddress, shortDate } from "../format";
import { viewHash, type View } from "../route";
import type { MessagePatch } from "./actions";
import { FOLDER_LABELS } from "./Sidebar";

export function MessageList({
  view,
  items,
  loading,
  hasMore,
  selectedId,
  labels,
  onLoadMore,
  onAct,
  onRefresh,
  className = "",
}: {
  view: View;
  items: MessageSummary[];
  loading: boolean;
  hasMore: boolean;
  selectedId: string | null;
  labels: Label[];
  onLoadMore: () => void;
  onAct: (ids: string[], patch: MessagePatch) => void;
  onRefresh: () => void;
  className?: string;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const ids = [...checked].filter((id) => items.some((m) => m.id === id));
  const labelName = new Map(labels.map((l) => [l.id, l]));

  function toggle(id: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function bulk(patch: MessagePatch) {
    onAct(ids, patch);
    setChecked(new Set());
  }

  const button = "rounded-md px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800";
  const title = view.kind === "folder" ? FOLDER_LABELS[view.folder] : view.kind === "starred" ? "Starred" : view.kind === "label" ? (labelName.get(view.labelId)?.name ?? "Label") : view.kind === "search" ? `Search: ${view.query}` : "";

  return (
    <section className={`w-full min-w-0 flex-col border-r border-neutral-200 md:w-96 md:shrink-0 dark:border-neutral-800 ${className}`}>
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <input
          type="checkbox"
          aria-label="Select all"
          checked={items.length > 0 && ids.length === items.length}
          onChange={(e) => setChecked(e.target.checked ? new Set(items.map((m) => m.id)) : new Set())}
        />
        {ids.length ? (
          <>
            <button className={button} onClick={() => bulk({ folder: "archive" })}>Archive</button>
            <button className={button} onClick={() => bulk({ folder: "trash" })}>Delete</button>
            <button className={button} onClick={() => bulk({ folder: "spam" })}>Spam</button>
            <button className={button} onClick={() => bulk({ isRead: true })}>Read</button>
            <button className={button} onClick={() => bulk({ isRead: false })}>Unread</button>
            <select
              className={`${button} bg-transparent`}
              value=""
              onChange={(e) => e.target.value && bulk({ folder: e.target.value as Folder })}
              aria-label="Move to"
            >
              <option value="">Move…</option>
              {(Object.keys(FOLDER_LABELS) as Folder[]).filter((f) => f !== "drafts" && f !== "sent").map((f) => (
                <option key={f} value={f}>{FOLDER_LABELS[f]}</option>
              ))}
            </select>
            {labels.length > 0 && (
              <select className={`${button} bg-transparent`} value="" onChange={(e) => e.target.value && bulk({ addLabels: [e.target.value] })} aria-label="Add label">
                <option value="">Label…</option>
                {labels.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            )}
          </>
        ) : (
          <>
            <h2 className="flex-1 truncate px-1 text-sm font-medium">{title}</h2>
            <button className={button} onClick={onRefresh}>Refresh</button>
          </>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {items.map((message) => (
          <li key={message.id} className={`flex gap-2 border-b border-neutral-100 px-3 py-2 dark:border-neutral-900 ${message.id === selectedId ? "bg-blue-50 dark:bg-blue-950/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}>
            <div className="flex flex-col items-center gap-1 pt-0.5">
              <input type="checkbox" aria-label="Select" checked={checked.has(message.id)} onChange={() => toggle(message.id)} />
              <button
                aria-label={message.isStarred ? "Unstar" : "Star"}
                onClick={() => onAct([message.id], { isStarred: !message.isStarred })}
                className={message.isStarred ? "text-amber-500" : "text-neutral-300 hover:text-neutral-500 dark:text-neutral-700"}
              >
                ★
              </button>
            </div>
            <a href={viewHash(view, message.id)} className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`truncate text-sm ${message.isRead ? "text-neutral-600 dark:text-neutral-400" : "font-semibold"}`}>
                  {message.direction === "out" ? `To: ${message.to.map(displayAddress).join(", ") || "(no recipients)"}` : displayAddress(message.from)}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">{shortDate(message.receivedAt)}</span>
              </div>
              <div className={`truncate text-sm ${message.isRead ? "text-neutral-600 dark:text-neutral-400" : "font-medium"}`}>
                {message.hasAttachments && <span aria-label="Has attachments">📎 </span>}
                {message.subject || "(no subject)"}
              </div>
              <div className="flex items-center gap-1 truncate text-xs text-neutral-500">
                {message.labelIds.map((id) => labelName.get(id)).filter(Boolean).map((l) => (
                  <span key={l!.id} className="rounded px-1 text-[10px] text-white" style={{ background: l!.color ?? "#9ca3af" }}>{l!.name}</span>
                ))}
                <span className="truncate">{message.parseStatus === "pending" ? "Not indexed yet" : message.parseStatus === "failed" ? "Could not be parsed" : message.snippet}</span>
              </div>
            </a>
          </li>
        ))}
        {!items.length && !loading && <li className="p-6 text-center text-sm text-neutral-400">No messages</li>}
        {loading && <li className="p-6 text-center text-sm text-neutral-400">Loading…</li>}
        {hasMore && !loading && (
          <li className="p-3 text-center">
            <button className={button} onClick={onLoadMore}>Load more</button>
          </li>
        )}
      </ul>
    </section>
  );
}
