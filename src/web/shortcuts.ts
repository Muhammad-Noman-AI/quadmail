// Gmail-style keyboard shortcuts. Pure mapping so it can be tested; the shell performs the actions.
export type ShortcutAction =
  | "compose"
  | "search"
  | "next"
  | "previous"
  | "open"
  | "back"
  | "archive"
  | "delete"
  | "star"
  | "reply"
  | "replyAll"
  | "forward"
  | "help";

export const SHORTCUT_HELP: Array<[string, string]> = [
  ["c", "Compose"],
  ["/", "Search"],
  ["j / k", "Next / previous message"],
  ["o or Enter", "Open message"],
  ["u or Esc", "Back to the list"],
  ["e", "Archive"],
  ["#", "Delete"],
  ["s", "Star / unstar"],
  ["r", "Reply"],
  ["a", "Reply all"],
  ["f", "Forward"],
  ["?", "Show this list"],
];

const KEYS: Record<string, ShortcutAction> = {
  c: "compose",
  "/": "search",
  j: "next",
  k: "previous",
  o: "open",
  Enter: "open",
  u: "back",
  Escape: "back",
  e: "archive",
  "#": "delete",
  s: "star",
  r: "reply",
  a: "replyAll",
  f: "forward",
  "?": "help",
};

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable === true;
}

/** The action for a key press, or null when it is not a shortcut or the user is typing. */
export function shortcutFor(event: KeyLike): ShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return null;
  return KEYS[event.key] ?? null;
}
