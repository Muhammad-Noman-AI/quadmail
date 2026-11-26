import { useEffect, useMemo, useState } from "react";
import type { MessageDetail, ParsedMessage } from "../../shared/types";
import { formatBytes } from "../format";
import { loadContent } from "../mail/content";
import { isDark } from "../theme";
import { frameDocument, inlineImageMap, plainTextToHtml, sanitizeEmailHtml } from "./sanitize";

const SENDER_KEY = "qm:remote-ok:";

function senderAllowsRemote(address: string | undefined): boolean {
  return !!address && localStorage.getItem(SENDER_KEY + address.toLowerCase()) === "1";
}

export function MessageBody({ message }: { message: MessageDetail }) {
  const [parsed, setParsed] = useState<ParsedMessage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [allowRemote, setAllowRemote] = useState(() => senderAllowsRemote(message.from?.address));
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    // Re-render the message frame when the theme changes.
    const onTheme = () => setDark(isDark());
    window.addEventListener("qm:theme", onTheme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", onTheme);
    return () => {
      window.removeEventListener("qm:theme", onTheme);
      media.removeEventListener("change", onTheme);
    };
  }, []);

  useEffect(() => {
    let active = true;
    loadContent(message)
      .then((result) => active && setParsed(result))
      .catch((err: unknown) => {
        if (!active) return;
        const text = err instanceof Error ? err.message : String(err);
        setFailure(text);
      });
    return () => {
      active = false;
    };
  }, [message]);

  const rendered = useMemo(() => {
    if (!parsed) return null;
    if (parsed.html) {
      const result = sanitizeEmailHtml(parsed.html, { allowRemote, inlineImages: inlineImageMap(parsed.attachments) });
      return { doc: frameDocument(result.html, allowRemote, dark), blocked: result.blockedRemote };
    }
    return { doc: frameDocument(plainTextToHtml(parsed.text ?? ""), false, dark), blocked: 0 };
  }, [parsed, allowRemote, dark]);

  if (failure) {
    return (
      <div className="space-y-2 px-4 pb-4 text-sm">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-200">{failure}</p>
        {message.snippet && <p className="whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">{message.snippet}</p>}
      </div>
    );
  }
  if (!rendered) return <p className="px-4 pb-4 text-sm text-neutral-400">Loading message…</p>;

  const files = (message.bodySource === "body" ? message.attachments : parsed!.attachments).filter((a) => !a.isInline);
  return (
    <div className="space-y-2 px-2 pb-3">
      {rendered.blocked > 0 && (
        <div className="mx-2 flex flex-wrap items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {rendered.blocked} remote image{rendered.blocked === 1 ? "" : "s"} blocked to protect your privacy.
          <button className="font-medium text-blue-600 hover:underline" onClick={() => setAllowRemote(true)}>Load images</button>
          {message.from?.address && (
            <button
              className="font-medium text-blue-600 hover:underline"
              onClick={() => {
                localStorage.setItem(SENDER_KEY + message.from!.address.toLowerCase(), "1");
                setAllowRemote(true);
              }}
            >
              Always load from {message.from.address}
            </button>
          )}
        </div>
      )}
      {message.authResults && /\b(spf|dkim|dmarc)=(fail|softfail|permerror)/i.test(message.authResults) && (
        <p className="mx-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          This message failed sender authentication (SPF/DKIM/DMARC). Be careful with links and attachments.
        </p>
      )}
      {/* No allow-scripts and no allow-same-origin: the email runs in an opaque origin without JavaScript.
          allow-popups lets links open in a new tab; the frame's own CSP blocks remote loads. */}
      <iframe
        title={`Message from ${message.from?.address ?? "unknown sender"}`}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={rendered.doc}
        className="h-[70vh] w-full rounded-lg border-0 bg-white dark:bg-neutral-900"
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-2">
          {files.map((file) => (
            <li key={file.id}>
              <a
                href={`/api/attachments/${file.id}`}
                className="block rounded-lg border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                download
              >
                📎 {file.filename ?? "attachment"} <span className="text-neutral-500">{formatBytes(file.sizeBytes)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
