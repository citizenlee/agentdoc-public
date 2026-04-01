#!/bin/bash
set -euo pipefail

payload="$(cat || true)"

if [ -z "$payload" ]; then
  exit 0
fi

paths="$(PROOF_HOOK_PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import sys

def walk(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)
    elif isinstance(value, str):
        yield value

try:
    data = json.loads(os.environ.get("PROOF_HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)

for value in walk(data):
    if "/" in value or value.endswith(".md") or value.endswith(".markdown"):
        print(value)
PY
)"

while IFS= read -r path; do
  [ -z "$path" ] && continue
  if [ -f "$path" ] && grep -Eq '<!-- PROOF|data-proof=' "$path"; then
    cat <<'EOF' >&2
Blocked direct write to a Proof-managed markdown file.

This repo is web-first. Use the hosted Proof APIs or the shared web document flow instead of editing the provenance-marked file directly.
EOF
    exit 2
  fi
done <<< "$paths"

exit 0
