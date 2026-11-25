#!/usr/bin/env bash
# Phase 2 acceptance: write and read back one R2 object and one D1 row (plus FTS).
# Usage: scripts/smoke.sh --local   (Miniflare state in .wrangler/)
#        scripts/smoke.sh --remote  (real Cloudflare resources; needs `wrangler login`)
set -euo pipefail
target="${1:---local}"
id="smoke-$(date +%s)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

wr() { pnpm -s wrangler "$@" 2>/dev/null; }
# Keep each SQL statement on one line: wrangler on Windows rejects multi-line --command.
# wrangler returns only the last statement's result, so run one statement per call.
d1() { wr d1 execute quadmail "$target" --json --command "$1" | sed -n '/^\[/,$p'; }

echo "R2: put + get raw/smoke/$id.eml"
printf 'Subject: smoke %s\r\n\r\nhello\r\n' "$id" > "$tmp/in.eml"
wr r2 object put "quadmail-mail/raw/smoke/$id.eml" --file "$tmp/in.eml" "$target" >/dev/null
wr r2 object get "quadmail-mail/raw/smoke/$id.eml" --file "$tmp/out.eml" "$target" >/dev/null
cmp -s "$tmp/in.eml" "$tmp/out.eml" || { echo "  R2 mismatch"; exit 1; }
wr r2 object delete "quadmail-mail/raw/smoke/$id.eml" "$target" >/dev/null
echo "  ok"

echo "D1: insert + FTS search + delete"
d1 "INSERT INTO messages (id, direction, folder, subject, from_addr, search_text, received_at) VALUES ('$id', 'in', 'inbox', 'Smoke test $id', 'smoke@example.com', 'zebracadabra', 0)" >/dev/null
out="$(d1 "SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH 'zebracadabra' AND m.id = '$id'")"
d1 "DELETE FROM messages WHERE id = '$id'" >/dev/null
grep -q "\"id\": \"$id\"" <<<"$out" || { echo "  D1/FTS check failed"; echo "$out"; exit 1; }
echo "  ok"

echo "Smoke test passed ($target)"
