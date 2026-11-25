import { useState, type FormEvent } from "react";
import type { Folder } from "../../shared/types";
import { api, ApiError, type Label } from "../api";
import { viewHash, type View } from "../route";

const NAV: Array<{ label: string; view: View; countKey?: string }> = [
  { label: "Inbox", view: { kind: "folder", folder: "inbox" }, countKey: "inbox" },
  { label: "Starred", view: { kind: "starred" } },
  { label: "Sent", view: { kind: "folder", folder: "sent" } },
  { label: "Drafts", view: { kind: "folder", folder: "drafts" }, countKey: "drafts" },
  { label: "Archive", view: { kind: "folder", folder: "archive" } },
  { label: "Spam", view: { kind: "folder", folder: "spam" }, countKey: "spam" },
  { label: "Trash", view: { kind: "folder", folder: "trash" } },
];

function sameView(a: View, b: View): boolean {
  return viewHash(a) === viewHash(b);
}

export const FOLDER_LABELS: Record<Folder, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash",
};

export function Sidebar({
  view,
  labels,
  counts,
  onLabelsChanged,
  onCompose,
  className = "",
}: {
  view: View;
  labels: Label[];
  counts: Record<string, number>;
  onLabelsChanged: () => void;
  onCompose: () => void;
  className?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function addLabel(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/labels", { body: { name } });
      setName("");
      setAdding(false);
      setError(null);
      onLabelsChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add label");
    }
  }

  const item = (active: boolean) =>
    `flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${
      active ? "bg-blue-100 font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200" : "text-neutral-700 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"
    }`;

  return (
    <nav className={`w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-200 p-3 dark:border-neutral-800 ${className}`}>
      <button onClick={onCompose} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
        Compose
      </button>
      <ul className="space-y-0.5">
        {NAV.map((entry) => {
          const count = entry.countKey ? counts[entry.countKey] : undefined;
          return (
            <li key={entry.label}>
              <a href={viewHash(entry.view)} className={item(sameView(entry.view, view))}>
                {entry.label}
                {count ? <span className="text-xs text-neutral-500">{count}</span> : null}
              </a>
            </li>
          );
        })}
      </ul>
      <div>
        <div className="flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Labels
          <button onClick={() => setAdding((v) => !v)} aria-label="New label" className="text-base leading-none hover:text-neutral-800 dark:hover:text-neutral-200">
            +
          </button>
        </div>
        {adding && (
          <form onSubmit={addLabel} className="mt-1 px-1">
            <input
              autoFocus
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label name"
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          </form>
        )}
        <ul className="mt-1 space-y-0.5">
          {labels.map((label) => {
            const labelView: View = { kind: "label", labelId: label.id };
            return (
              <li key={label.id}>
                <a href={viewHash(labelView)} className={item(sameView(labelView, view))}>
                  <span className="flex items-center gap-2 truncate">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: label.color ?? "#9ca3af" }} />
                    {label.name}
                  </span>
                </a>
              </li>
            );
          })}
          {!labels.length && !adding && <li className="px-3 text-xs text-neutral-400">No labels yet</li>}
        </ul>
      </div>
      <a href="#/settings" className={`${item(view.kind === "settings")} mt-auto`}>
        Settings
      </a>
    </nav>
  );
}
