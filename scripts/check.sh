#!/usr/bin/env bash
# Repository checks, run by the pre-commit hook and by CI.
#  1. No file git would commit holds the replacement character U+FFFD or the
#     author's local user name (which also covers home paths and the email).
#  2. markdownlint passes on every Markdown file.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Built from pieces so this script does not match itself.
user_name="$(printf '%s%s' 'sea' 'nr')"
replacement_char="$(printf '\xef\xbf\xbd')"

status=0
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  if grep -q -F -e "$replacement_char" -- "$file"; then
    echo "check: $file holds U+FFFD (a broken character)" >&2
    status=1
  fi
  if grep -q -i -F -e "$user_name" -- "$file"; then
    echo "check: $file holds the local user name or a path under the home folder" >&2
    status=1
  fi
done < <(git ls-files -z --cached --others --exclude-standard)

npx --yes markdownlint-cli2@0.13.0 "**/*.md" || status=1

exit "$status"
