#!/usr/bin/env bash
# Runs every fixture in runcard/test/refresh-fixtures through `runcard.refreshPlan` and
# compares outcome, status, close and each item's `name`, `st` and `note` with `expect`.
# Usage (from the repository root): runcard/test/run-refresh-fixtures.sh
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
rc=0
for f in "$dir"/refresh-fixtures/*.json; do
  name="$(basename "$f" .json)"
  got="$(dagger --progress plain -m "$dir/.." call refresh-plan \
    --jobs="$(jq -c .jobs "$f")" --rows="$(jq -c .rows "$f")" --self-job="$(jq -r '.selfJob // ""' "$f")" \
    --final="$(jq -r '.final // false' "$f")" 2>/dev/null)"
  diff="$(jq -n --argjson got "$got" --argjson exp "$(jq -c .expect "$f")" '
    def slim: {outcome, status, close, items: [.items[] | {name, st, note: (.note // null)}]};
    ($exp | .items |= map({name, st, note: (.note // null)})) as $e
    | ($got | slim) as $g
    | if $g == ($e | slim) then [] else [{expected: $e, got: $g}] end')"
  if [ "$diff" = "[]" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name: $diff"
    echo "::error title=runcard refresh fixture failed::$name — $(jq -r .why "$f")"
    rc=1
  fi
done
exit $rc
