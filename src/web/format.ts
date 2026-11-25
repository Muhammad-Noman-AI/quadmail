import type { Address } from "../shared/types";

export function displayAddress(address: Address | null | undefined): string {
  if (!address) return "(unknown sender)";
  return address.name?.trim() || address.address;
}

export function shortDate(epochMs: number, now = Date.now()): string {
  const date = new Date(epochMs);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.getFullYear() === today.getFullYear()) return date.toLocaleDateString([], { month: "short", day: "numeric" });
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function longDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
