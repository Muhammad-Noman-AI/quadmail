import { useEffect, useState } from "react";
import type { Folder, MessageDetail, MessageSummary } from "../../shared/types";
import { api, ApiError, type Label } from "../api";
import { displayAddress, longDate } from "../format";
import { navigate, viewHash, type View } from "../route";
import type { ReplyMode } from "../compose/prepare";
import type { MessagePatch } from "../shell/actions";
import { MessageBody } from "./MessageBody";

export function Reader({
  messageId,
  summary,
  view,
  labels,
  onAct,
  onNotice,
  onReply,
}: {
  messageId: string;
  summary: MessageSummary | null;
  view: View;
  labels: Label[];
  onAct: (ids: string[], patch: MessagePatch) => void;
  onNotice: (message: string) => void;
  onReply: (message: MessageDetail, mode: ReplyMode) => void;
}) {
  const [thread, setThread] = useState<MessageDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([messageId]));

  useEffect(() => {
    let active = true;
    (async () => {
      const message = await api<MessageDetail>(`/api/messages/${messageId}`);
      const messages = message.threadId ? (await api<{ messages: MessageDetail[] }>(`/api/threads/${message.threadId}`)).messages : [message];
      if (!active) return;
      setThread(messages.some((m) => m.id === messageId) ? messages : [message]);
      if (!message.isRead) onAct([messageId], { isRead: true });
    })().catch((err: unknown) => active && setError(err instanceof ApiError ? err.message : "Could not load the message"));
    return () => {
      active = false;
    };
    // Load once per message; onAct identity changes on every render of the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  const current = thread?.find((m) => m.id === messageId) ?? null;
  const base = summary ?? current;
  const back = viewHash(view);
  const button = "rounded-md px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800";

  async function blockSender() {
    try {
      const result = await api<{ address: string }>(`/api/messages/${messageId}/block-sender`, { method: "POST" });
      onNotice(`Blocked ${result.address}. Their messages now go to Spam.`);
      onAct([messageId], { folder: "spam" });
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not block sender");
    }
  }

  function move(folder: Folder) {
    onAct([messageId], { folder });
    navigate(back);
  }

  return (
    <article className="flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-900">
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <a href={back} className={`${button} md:hidden`}>← Back</a>
        {current && (
          <>
            <button className={`${button} font-medium`} onClick={() => onReply(current, "reply")}>Reply</button>
            <button className={button} onClick={() => onReply(current, "replyAll")}>Reply all</button>
            <button className={button} onClick={() => onReply(current, "forward")}>Forward</button>
          </>
        )}
        <button className={button} onClick={() => move("archive")}>Archive</button>
        <button className={button} onClick={() => move("trash")}>Delete</button>
        <button className={button} onClick={() => move("spam")}>Spam</button>
        {base?.folder !== "inbox" && <button className={button} onClick={() => move("inbox")}>Move to Inbox</button>}
        <button className={button} onClick={() => { onAct([messageId], { isRead: false }); navigate(back); }}>Mark unread</button>
        {base && (
          <button className={button} onClick={() => onAct([messageId], { isStarred: !base.isStarred })}>{base.isStarred ? "Unstar" : "Star"}</button>
        )}
        {base?.direction === "in" && <button className={button} onClick={blockSender}>Block sender</button>}
        {labels.length > 0 && base && (
          <select
            className={`${button} bg-transparent`}
            value=""
            aria-label="Toggle label"
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              onAct([messageId], base.labelIds.includes(id) ? { removeLabels: [id] } : { addLabels: [id] });
            }}
          >
            <option value="">Labels…</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>{base.labelIds.includes(l.id) ? "✓ " : ""}{l.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-sm text-red-600">{error}</p>}
        {!thread && !error && <p className="p-6 text-sm text-neutral-400">Loading…</p>}
        {thread && (
          <>
            <h1 className="px-5 pt-4 text-lg font-semibold">{current?.subject || thread[0]?.subject || "(no subject)"}</h1>
            <ol className="space-y-2 p-3">
              {thread.map((message) => {
                const open = expanded.has(message.id);
                return (
                  <li key={message.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800">
                    <button
                      className="flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left"
                      onClick={() => setExpanded((s) => { const next = new Set(s); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}
                    >
                      <span className="min-w-0">
                        <span className="text-sm font-medium">{displayAddress(message.from)}</span>
                        {message.from && message.from.name && <span className="ml-1 text-xs text-neutral-500">&lt;{message.from.address}&gt;</span>}
                        {!open && <span className="block truncate text-xs text-neutral-500">{message.snippet}</span>}
                        {open && (
                          <span className="block text-xs text-neutral-500">
                            to {message.to.map(displayAddress).join(", ") || "—"}
                            {message.cc.length ? `, cc ${message.cc.map(displayAddress).join(", ")}` : ""}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right text-xs text-neutral-500">
                        {longDate(message.receivedAt)}
                        {message.sendStatus && (
                          <span className={`block ${["bounced", "complained", "failed"].includes(message.sendStatus) ? "font-medium text-red-600" : ""}`}>
                            {message.sendStatus === "bounced" ? "Bounced: address suppressed" : message.sendStatus === "complained" ? "Marked as spam by recipient" : message.sendStatus}
                          </span>
                        )}
                      </span>
                    </button>
                    {open && <MessageBody message={message} />}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </article>
  );
}
