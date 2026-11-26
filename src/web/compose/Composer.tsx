import { useEffect, useRef, useState } from "react";
import type { AttachmentMeta, DraftInput, MessageDetail, SendingInfo, StoredBody } from "../../shared/types";
import { api, ApiError } from "../api";
import { formatBytes } from "../format";
import { formatAddressInput, parseAddressInput } from "./addresses";
import { composeText, sanitizeComposeHtml } from "./html";
import type { ComposeInit } from "./prepare";
import { newMessageInit } from "./prepare";

const AUTOSAVE_MS = 2000;

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

export function Composer({
  draftId,
  init,
  onClose,
  onSent,
  onChanged,
}: {
  /** Open an existing draft, or start from `init` (null init = blank message). */
  draftId: string | null;
  init: ComposeInit | null;
  onClose: () => void;
  onSent: () => void;
  /** A draft was created, saved or deleted: the lists and counts may need refreshing. */
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<SendingInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [from, setFrom] = useState("");
  const [toText, setToText] = useState("");
  const [ccText, setCcText] = useState("");
  const [bccText, setBccText] = useState("");
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState("");
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [uploading, setUploading] = useState(0);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);

  const editor = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(draftId);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const fields = useRef({ from, toText, ccText, bccText, subject });
  // Autosave timers read the latest field values from here.
  useEffect(() => {
    fields.current = { from, toText, ccText, bccText, subject };
  });

  function payload(): DraftInput {
    const html = sanitizeComposeHtml(editor.current?.innerHTML ?? "");
    const f = fields.current;
    return {
      from: f.from,
      to: parseAddressInput(f.toText).addresses,
      cc: parseAddressInput(f.ccText).addresses,
      bcc: parseAddressInput(f.bccText).addresses,
      subject: f.subject,
      html,
      text: composeText(html),
    };
  }

  /** Saves are queued so the first one creates the draft and later ones update it. Resolves to the draft id. */
  function save(): Promise<string> {
    if (timer.current) clearTimeout(timer.current);
    const run = queue.current
      .catch(() => {})
      .then(async () => {
        if (idRef.current && !dirty.current) return idRef.current;
        setStatus("saving");
        dirty.current = false;
        const body = payload();
        try {
          if (idRef.current) await api(`/api/drafts/${idRef.current}`, { method: "PUT", body });
          else idRef.current = (await api<{ id: string }>("/api/drafts", { body: { ...body, replyToId: init?.replyToId } })).id;
        } catch (err) {
          dirty.current = true;
          setStatus("idle");
          throw err;
        }
        setStatus("saved");
        onChanged();
        return idRef.current;
      });
    queue.current = run;
    return run;
  }

  function touch() {
    dirty.current = true;
    setStatus("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save().catch((err: unknown) => setError(message(err, "Could not save the draft"))), AUTOSAVE_MS);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function upload(file: Blob, name: string) {
    setUploading((n) => n + 1);
    try {
      const id = await save();
      const response = await fetch(`/api/drafts/${id}/attachments`, {
        method: "POST",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(name) },
        credentials: "same-origin",
      });
      const data = (await response.json().catch(() => ({}))) as AttachmentMeta & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Upload failed (${response.status})`);
      setAttachments((list) => [...list, data]);
    } finally {
      setUploading((n) => n - 1);
    }
  }

  // Load the identities and quota, then either the saved draft or the initial content.
  useEffect(() => {
    let active = true;
    (async () => {
      const sending = await api<SendingInfo>("/api/sending");
      if (!active) return;
      setInfo(sending);
      const fallbackFrom = (sending.identities.find((i) => i.isDefault) ?? sending.identities[0])?.address ?? "";
      let html: string;
      if (draftId) {
        const [detail, body] = await Promise.all([api<MessageDetail>(`/api/messages/${draftId}`), api<StoredBody>(`/api/messages/${draftId}/body`)]);
        if (!active) return;
        setFrom(detail.from?.address ?? fallbackFrom);
        setToText(formatAddressInput(detail.to));
        setCcText(formatAddressInput(detail.cc));
        setBccText(formatAddressInput(detail.bcc));
        setShowCopies(detail.cc.length + detail.bcc.length > 0);
        setSubject(detail.subject ?? "");
        setAttachments(detail.attachments);
        html = body.html;
      } else {
        const start = init ?? newMessageInit(sending.identities.find((i) => i.isDefault));
        setFrom(start.from ?? fallbackFrom);
        setToText(formatAddressInput(start.to));
        setCcText(formatAddressInput(start.cc));
        setShowCopies(start.cc.length > 0);
        setSubject(start.subject);
        html = start.html;
        if (start.forwardAttachments?.length) dirty.current = true;
      }
      if (editor.current) editor.current.innerHTML = sanitizeComposeHtml(html);
      setLoaded(true);
      // Forwarding: copy the original's files into this draft through the browser.
      for (const file of init?.forwardAttachments ?? []) {
        if (!active) return;
        const response = await fetch(`/api/attachments/${file.id}`, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`Could not copy ${file.filename ?? "an attachment"}`);
        const blob = await response.blob();
        await upload(new Blob([blob], { type: file.contentType ?? "application/octet-stream" }), file.filename ?? "attachment");
      }
    })().catch((err: unknown) => active && setError(message(err, "Could not open the composer")));
    return () => {
      active = false;
    };
    // Runs once per composer instance (the shell remounts it with a new key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addFiles(files: FileList | null) {
    if (!files?.length || !info) return;
    setError(null);
    let total = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
    for (const file of Array.from(files)) {
      if (total + file.size > info.maxAttachmentBytes) {
        setError(`${file.name} is too big: attachments are limited to ${formatBytes(info.maxAttachmentBytes)} per message.`);
        return;
      }
      total += file.size;
      try {
        await upload(file, file.name);
      } catch (err) {
        setError(message(err, `Could not attach ${file.name}`));
        return;
      }
    }
  }

  async function removeAttachment(attachment: AttachmentMeta) {
    if (!idRef.current) return;
    try {
      await api(`/api/drafts/${idRef.current}/attachments/${attachment.id}`, { method: "DELETE" });
      setAttachments((list) => list.filter((a) => a.id !== attachment.id));
    } catch (err) {
      setError(message(err, "Could not remove the attachment"));
    }
  }

  async function send() {
    setError(null);
    const invalid = [toText, ccText, bccText].flatMap((text) => parseAddressInput(text).invalid);
    if (invalid.length) return setError(`Check these addresses: ${invalid.join(", ")}`);
    if (!parseAddressInput(toText).addresses.length) return setError("Add at least one recipient in To.");
    if (uploading) return setError("Wait for the attachments to finish uploading.");
    setStatus("sending");
    try {
      const id = await save();
      await api(`/api/drafts/${id}/send`, { method: "POST" });
      onSent();
    } catch (err) {
      setStatus("idle");
      setError(message(err, "Could not send the message"));
      api<SendingInfo>("/api/sending").then(setInfo).catch(() => {});
    }
  }

  async function close() {
    try {
      if (dirty.current) await save();
      onClose();
    } catch (err) {
      setError(message(err, "Could not save the draft"));
    }
  }

  async function discard() {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = false;
    await queue.current.catch(() => {});
    try {
      if (idRef.current) await api(`/api/drafts/${idRef.current}`, { method: "DELETE" });
      onChanged();
      onClose();
    } catch (err) {
      setError(message(err, "Could not discard the draft"));
    }
  }

  function format(command: string) {
    if (command === "createLink") {
      const url = window.prompt("Link address (https://…)")?.trim();
      if (!url || !/^(https?:\/\/|mailto:)/i.test(url)) return;
      document.execCommand(command, false, url);
    } else document.execCommand(command);
    touch();
  }

  const nearLimit = info && info.sentToday >= info.dailyLimit * 0.8;
  const input = "w-full bg-transparent px-1 py-1.5 text-sm outline-none";
  const row = "flex items-center gap-2 border-b border-neutral-200 px-4 dark:border-neutral-800";
  const tool = "rounded px-2 py-0.5 text-sm hover:bg-neutral-200 dark:hover:bg-neutral-800";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-900" aria-label="Compose message">
      <div className="flex min-h-11 items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">{draftId ? "Draft" : init?.replyToId ? "Reply" : "New message"}</h2>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span aria-live="polite">{status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "sending" ? "Sending…" : ""}</span>
          <button onClick={close} aria-label="Close" className="rounded px-2 py-1 text-base leading-none hover:bg-neutral-200 dark:hover:bg-neutral-800">×</button>
        </div>
      </div>

      {info && !info.providerReady && (
        <p className="bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Sending is not set up yet (Resend is not connected). You can still write and save drafts.
        </p>
      )}
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-1.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
      )}

      <div className={row}>
        <label className="w-14 shrink-0 text-xs text-neutral-500" htmlFor="qm-from">From</label>
        <select id="qm-from" className={input} value={from} onChange={(e) => { setFrom(e.target.value); touch(); }}>
          {info?.identities.map((identity) => (
            <option key={identity.id} value={identity.address}>
              {identity.displayName ? `${identity.displayName} <${identity.address}>` : identity.address}
            </option>
          ))}
        </select>
      </div>
      <div className={row}>
        <label className="w-14 shrink-0 text-xs text-neutral-500" htmlFor="qm-to">To</label>
        <input id="qm-to" className={input} value={toText} autoFocus={!draftId && !init?.replyToId} placeholder="name@example.com, Ali <ali@example.com>" onChange={(e) => { setToText(e.target.value); touch(); }} />
        {!showCopies && <button className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200" onClick={() => setShowCopies(true)}>Cc/Bcc</button>}
      </div>
      {showCopies && (
        <>
          <div className={row}>
            <label className="w-14 shrink-0 text-xs text-neutral-500" htmlFor="qm-cc">Cc</label>
            <input id="qm-cc" className={input} value={ccText} onChange={(e) => { setCcText(e.target.value); touch(); }} />
          </div>
          <div className={row}>
            <label className="w-14 shrink-0 text-xs text-neutral-500" htmlFor="qm-bcc">Bcc</label>
            <input id="qm-bcc" className={input} value={bccText} onChange={(e) => { setBccText(e.target.value); touch(); }} />
          </div>
        </>
      )}
      <div className={row}>
        <label className="w-14 shrink-0 text-xs text-neutral-500" htmlFor="qm-subject">Subject</label>
        <input id="qm-subject" className={input} value={subject} maxLength={998} onChange={(e) => { setSubject(e.target.value); touch(); }} />
      </div>

      <div className="flex flex-wrap gap-1 border-b border-neutral-200 px-3 py-1 dark:border-neutral-800" role="toolbar" aria-label="Formatting">
        {/* onMouseDown keeps the editor's selection, which a click would otherwise clear. */}
        <button className={`${tool} font-bold`} onMouseDown={(e) => e.preventDefault()} onClick={() => format("bold")} aria-label="Bold">B</button>
        <button className={`${tool} italic`} onMouseDown={(e) => e.preventDefault()} onClick={() => format("italic")} aria-label="Italic">I</button>
        <button className={`${tool} underline`} onMouseDown={(e) => e.preventDefault()} onClick={() => format("underline")} aria-label="Underline">U</button>
        <button className={tool} onMouseDown={(e) => e.preventDefault()} onClick={() => format("insertUnorderedList")} aria-label="Bulleted list">• List</button>
        <button className={tool} onMouseDown={(e) => e.preventDefault()} onClick={() => format("insertOrderedList")} aria-label="Numbered list">1. List</button>
        <button className={tool} onMouseDown={(e) => e.preventDefault()} onClick={() => format("createLink")} aria-label="Insert link">Link</button>
      </div>

      <div
        ref={editor}
        contentEditable={loaded}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        className="min-h-40 flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed outline-none [&_blockquote]:ml-2 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_a]:text-blue-600 [&_a]:underline"
        onInput={touch}
        onPaste={(e) => {
          // Paste as plain text: no remote images, styles or scripts from the clipboard.
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
      />

      {(attachments.length > 0 || uploading > 0) && (
        <ul className="flex flex-wrap gap-2 border-t border-neutral-200 px-4 py-2 dark:border-neutral-800">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-lg border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-700">
              📎 {a.filename ?? "attachment"} <span className="text-neutral-500">{formatBytes(a.sizeBytes)}</span>
              <button onClick={() => removeAttachment(a)} aria-label={`Remove ${a.filename ?? "attachment"}`} className="text-neutral-500 hover:text-red-600">×</button>
            </li>
          ))}
          {uploading > 0 && <li className="px-2 py-1 text-xs text-neutral-500">Uploading…</li>}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <button
          onClick={send}
          disabled={!loaded || status === "sending" || !info?.providerReady}
          title={info && !info.providerReady ? "Sending is not set up yet" : undefined}
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "sending" ? "Sending…" : "Send"}
        </button>
        <label className="cursor-pointer rounded-lg px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800">
          Attach
          <input type="file" multiple className="sr-only" disabled={!loaded} onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
        </label>
        <button onClick={discard} className="rounded-lg px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800">Discard</button>
        {info && (
          <span className={`ml-auto text-xs ${nearLimit ? "font-medium text-amber-700 dark:text-amber-300" : "text-neutral-500"}`}>
            {info.sentToday} of {info.dailyLimit} sent today{nearLimit ? " — close to the daily limit" : ""}
          </span>
        )}
      </div>
    </section>
  );
}
