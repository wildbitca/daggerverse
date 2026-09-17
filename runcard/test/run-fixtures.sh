#!/usr/bin/env bash
# Runs every fixture in runcard/test/fixtures through `runcard.cardRows` and compares
# each row's `st` and `note` (and `ms` when the fixture states it) with `expect`.
# Usage (from the repository root): runcard/test/run-fixtures.sh
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
rc=0
for f in "$dir"/fixtures/*.json; do
  name="$(basename "$f" .json)"
  got="$(dagger --progress plain -m "$dir/.." call card-rows \
    --jobs="$(jq -c .jobs "$f")" --rows="$(jq -c .rows "$f")" --self-job="$(jq -r '.selfJob // ""' "$f")" 2>/dev/null)"
  diff="$(jq -n --argjson got "$got" --argjson exp "$(jq -c .expect "$f")" '
    [ range(0; ([$got, $exp] | map(length) | max)) as $i
      | ($got[$i] // {}) as $g | ($exp[$i] // {}) as $e
      | select($g.name != $e.name or $g.st != $e.st or ($g.note // null) != $e.note
               or (($e | has("ms")) and $g.ms != $e.ms))
      | {row: $i, expected: $e, got: $g} ]')"
  if [ "$diff" = "[]" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name: $diff"
    echo "::error title=runcard fixture failed::$name — $(jq -r .why "$f")"
    rc=1
  fi
done
exit $rc
