#!/usr/bin/env bash
# Runs <module>/test/cases.json in order, each case one `dagger call` on the LOCAL module.
#
# Argument values:
#   "@a+b"          contents of fixtures/a followed by fixtures/b (the files are concatenated)
#   "=case"         the output of an earlier case; "=case.path" a jq path inside it
#   ["=a", "=b"]    a JSON array of earlier outputs
#   "dir:path"      a directory under fixtures, passed as a Directory
#   anything else   passed as given
#
# Each `expect` key is a jq filter over the output; the value is the exact JSON it must
# produce. `raw` cases compare `contains` substrings against the raw output instead.
# `error` cases must FAIL, with the module's own message containing that substring.
# Usage (from the repository root): test/run-cases.sh testing
set -euo pipefail
module="${1:?usage: test/run-cases.sh <module>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/$module/test"
fx="$dir/fixtures"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
rc=0
# CASES is overridable so the harness itself can be reprobated with a case that must fail.
cases="${CASES:-$dir/cases.json}"
n="$(jq length "$cases")"
# Zero cases is not a pass: an unreadable or empty cases file would otherwise exit 0.
[ "${n:-0}" -ge 1 ] || { echo "::error title=$module fixtures::no cases in $cases"; exit 1; }

resolve() { # $1 = JSON value of one argument; prints the string to pass
  local v="$1" s
  if [ "$(jq -r type <<<"$v")" = "array" ]; then
    local parts=() ref
    while IFS= read -r ref; do parts+=("$(resolve "$(jq -n --arg r "$ref" '$r')")"); done < <(jq -r '.[]' <<<"$v")
    printf '%s\n' "${parts[@]}" | jq -cs .
    return
  fi
  s="$(jq -r . <<<"$v")"
  case "$s" in
    @*)
      local f
      IFS='+' read -ra files <<<"${s#@}"
      for f in "${files[@]}"; do cat "$fx/$f"; done
      ;;
    =*)
      local ref="${s#=}" name path
      name="${ref%%.*}"
      if [ "$name" = "$ref" ]; then cat "$out/$name.json"; else path="${ref#*.}"; jq -c ".$path" "$out/$name.json"; fi
      ;;
    *) printf '%s' "$s" ;;
  esac
}

for ((i = 0; i < n; i++)); do
  c="$(jq -c ".[$i]" "$cases")"
  name="$(jq -r .name <<<"$c")"
  fn="$(jq -r .fn <<<"$c")"
  [ -n "$name" ] && [ "$name" != null ] && [ -n "$fn" ] && [ "$fn" != null ] || { echo "::error title=$module fixtures::case $i has no name or fn (a CASES file read twice, e.g. a <(…) substitution, reads empty)"; exit 1; }
  args=()
  while IFS= read -r k; do
    v="$(jq -c --arg k "$k" '.args[$k]' <<<"$c")"
    s="$(jq -r 'if type == "string" then . else "" end' <<<"$v")"
    if [[ "$s" == dir:* ]]; then args+=("--$k=$fx/${s#dir:}"); else args+=("--$k=$(resolve "$v")"); fi
  done < <(jq -r '.args | keys_unsorted[]' <<<"$c")

  want_err="$(jq -r '.error // ""' <<<"$c")"
  if [ -n "$want_err" ]; then
    if dagger --progress plain -m "$root/$module" call "$fn" "${args[@]}" >/dev/null 2>"$out/$name.err"; then
      echo "FAIL $name: expected an error containing '$want_err', the call succeeded"; rc=1
    elif grep -qF -- "$want_err" "$out/$name.err"; then
      echo "ok   $name (errors as expected)"
    else
      echo "FAIL $name: the call failed, but not with '$want_err' — a load or wiring error is not the refusal under test"
      sed 's/\x1b\[[0-9;]*m//g' "$out/$name.err" | grep -v '^\s*$' | tail -4 | cut -c1-400 | sed 's/^/     /'
      rc=1
    fi
    continue
  fi
  if ! got="$(dagger --progress plain -m "$root/$module" call "$fn" "${args[@]}" 2>"$out/$name.err")"; then
    echo "FAIL $name: dagger call $fn errored"
    sed 's/\x1b\[[0-9;]*m//g' "$out/$name.err" | grep -v '^\s*$' | tail -4 | cut -c1-400 | sed 's/^/     /'
    echo "::error title=$module fixture failed::$name — $(jq -r .why <<<"$c")"
    rc=1
    continue
  fi
  printf '%s' "$got" >"$out/$name.json"

  bad=()
  if [ "$(jq -r '.raw // false' <<<"$c")" = "true" ]; then
    while IFS= read -r needle; do
      grep -qF -- "$needle" "$out/$name.json" || bad+=("missing substring: $needle")
    done < <(jq -r '.contains[]' <<<"$c")
  else
    while IFS= read -r filter; do
      exp="$(jq -cS --arg f "$filter" '.expect[$f]' <<<"$c")"
      act="$(jq -cS "$filter" "$out/$name.json" 2>&1 || true)"
      [ "$act" = "$exp" ] || bad+=("$filter: expected $exp, got $act")
    done < <(jq -r '.expect | keys_unsorted[]' <<<"$c")
  fi

  if [ ${#bad[@]} -eq 0 ]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    printf '     %s\n' "${bad[@]}"
    echo "::error title=$module fixture failed::$name — $(jq -r .why <<<"$c")"
    rc=1
  fi
done
exit $rc
