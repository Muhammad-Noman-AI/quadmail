// Hash routing: #/inbox, #/inbox/<messageId>, #/starred, #/label/<id>, #/search/<query>, #/settings, #/team, #/usage
import { useEffect, useState } from "react";
import { FOLDERS, type Folder } from "../shared/types";

export type View =
  | { kind: "folder"; folder: Folder }
  | { kind: "starred" }
  | { kind: "label"; labelId: string }
  | { kind: "search"; query: string }
  | { kind: "settings" }
  | { kind: "team" }
  | { kind: "usage" };

export interface Route {
  view: View;
  messageId: string | null;
}

const ID = /^[0-9A-Z]{26}$/;

export function parseHash(hash: string): Route {
  const [first = "inbox", second, third] = hash.replace(/^#\/?/, "").split("/");
  if (first === "settings") return { view: { kind: "settings" }, messageId: null };
  if (first === "team") return { view: { kind: "team" }, messageId: null };
  if (first === "usage") return { view: { kind: "usage" }, messageId: null };
  if (first === "starred") return { view: { kind: "starred" }, messageId: second && ID.test(second) ? second : null };
  if (first === "label" && second && ID.test(second)) return { view: { kind: "label", labelId: second }, messageId: third && ID.test(third) ? third : null };
  if (first === "search" && second !== undefined) {
    return { view: { kind: "search", query: decodeURIComponent(second) }, messageId: third && ID.test(third) ? third : null };
  }
  const folder = (FOLDERS as readonly string[]).includes(first) ? (first as Folder) : "inbox";
  return { view: { kind: "folder", folder }, messageId: second && ID.test(second) ? second : null };
}

export function viewHash(view: View, messageId?: string | null): string {
  const base =
    view.kind === "folder"
      ? `#/${view.folder}`
      : view.kind === "starred"
        ? "#/starred"
        : view.kind === "label"
          ? `#/label/${view.labelId}`
          : view.kind === "search"
            ? `#/search/${encodeURIComponent(view.query)}`
            : view.kind === "team"
              ? "#/team"
              : view.kind === "usage"
                ? "#/usage"
                : "#/settings";
  return messageId ? `${base}/${messageId}` : base;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
}
