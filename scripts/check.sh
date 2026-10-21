#!/usr/bin/env bash
# Repository checks, run by the pre-commit hook and by CI.
#  1. No file git would commit holds the replacement character U+FFFD or the
#     author's local user name (which also covers home paths and the email).
#  2. markdownlint passes on every Markdown file.
#  3. The mod's version in its code, which it reports to the host, is the one
#     .claude-plugin/plugin.json states. Its tests cannot read the manifest.
#  4. That version is at least the newest v* release tag, so main never sits
#     behind a release. Skipped when the clone has no tags.
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

manifest_version="$(node -p "require('./.claude-plugin/plugin.json').version")"
code_version="$(sed -n "s/^export const MOD_VERSION = '\([^']*\)'$/\1/p" hooks/events.ts)"
if [ -z "$code_version" ] || [ "$code_version" != "$manifest_version" ]; then
  echo "check: MOD_VERSION in hooks/events.ts is \"$code_version\", but .claude-plugin/plugin.json states \"$manifest_version\"" >&2
  status=1
fi

latest_tag="$(git tag --list 'v*' --sort=-version:refname | head -n 1)"
if [ -n "$latest_tag" ]; then
  latest_version="${latest_tag#v}"
  lowest="$(printf '%s\n%s\n' "$latest_version" "$manifest_version" | sort -V | head -n 1)"
  if [ "$lowest" != "$latest_version" ]; then
    echo "check: .claude-plugin/plugin.json states \"$manifest_version\", behind the release tag $latest_tag" >&2
    status=1
  fi
fi

exit "$status"
