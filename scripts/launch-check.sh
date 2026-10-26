#!/usr/bin/env bash
# Launch check: run before publishing a release, on the tarball that will be published.
#
#   scripts/launch-check.sh path/to/llm-harness-builder-X.Y.Z.tgz
#
# Host mode checks the tarball, then re-runs this file inside a node:22.12-slim container
# (Docker needed) that installs the tarball like a user would and drives it.
# Each step prints PASS, FAIL or SKIP; exit 0 = GREEN, 1 = a step failed, 3 = SKIPs, not green.
# Keys are passed by name only (docker -e NAME) and never printed. A key that is not set
# SKIPs its step. A SKIP is not green.
#
# Checklist:
#   1. the tarball exists, the repo is clean                                   (host)
#   2. the tarball holds only tracked files, dist/ and web/dist/; the entry files are there
#   3. nothing that ties it to a machine or an account (paths, keys, user name, email)
#   4. sha256 and sha1 printed; the sha1 is what `npm view ... dist.shasum` reports later
#   5. Docker is running
#   6. the container: Node 22.12, `npm i` without EBADENGINE, --version and --help,
#      demo without a server, serve + example runs + bench + harnesses/bare.json,
#      analyze (1710 s), OpenRouter demo, Anthropic bench, links, no key in logs
#   7. MANUAL: the page in a browser (serve; Run tab, Bench tab, a theme switch)
#   8. MANUAL: README renders on GitHub, both languages, the GIF plays
#   9. MANUAL: `git tag -a vX.Y.Z`, `gh release create vX.Y.Z <tgz>`, `npm publish <tgz>` (2FA)
#  10. MANUAL: `npm view llm-harness-builder@X.Y.Z dist.shasum` equals the sha1 of step 4
#
# Free model gone or rate-limited: rerun with OPENROUTER_MODEL=<another :free id with tool
# support from https://openrouter.ai/api/v1/models>. It must list `tools` and
# `response_format` in supported_parameters (the demo enforces a schema). Current ids:
#   google/gemma-4-31b-it:free
#   google/gemma-4-26b-a4b-it:free
set -euo pipefail

MODEL=${OPENROUTER_MODEL:-nvidia/nemotron-3.5-super-vl:free}
fails=0 skips=0

# step NAME FUNCTION...: a function prints why on failure and returns 1, or returns 77 to skip.
step() {
  local name=$1 rc=0 out why
  shift
  out=$("$@" 2>&1) || rc=$?
  why=$(printf '%s' "$out" | grep -v '^$' | tail -n 1 | cut -c1-300 || true)
  case $rc in
    0) echo "PASS $name" ;;
    77) echo "SKIP $name: $why"; skips=$((skips + 1)) ;;
    *) echo "FAIL $name: $why"; fails=$((fails + 1)) ;;
  esac
}

finish() {
  if [ "$fails" -eq 0 ] && [ "$skips" -eq 0 ]; then echo GREEN; return 0; fi
  echo "NOT GREEN: $fails failed, $skips skipped"
  if [ "$fails" -gt 0 ]; then return 1; fi
  return 3
}

# ---------------------------------------------------------------- host mode

host() {
  local tgz=$1 repo here tmp
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  repo=$(cd "$here/.." && pwd)
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  h_tree() {
    [ -f "$tgz" ] || { echo "no such file: $tgz"; return 1; }
    [ -z "$(git -C "$repo" status --porcelain)" ] || { echo "the repo is not clean (git status --porcelain)"; return 1; }
  }
  h_entries() {
    local e f
    git -C "$repo" ls-files > "$tmp/tracked"
    tar tzf "$tgz" > "$tmp/entries"
    while IFS= read -r e; do
      f=${e#package/}
      case $f in
        "" | */) continue ;;
        .superpowers* | runs/* | scripts/*) echo "must not ship: $f"; return 1 ;;
        dist/* | web/dist/*) continue ;;
      esac
      grep -qxF -- "$f" "$tmp/tracked" || { echo "not tracked: $f"; return 1; }
    done < "$tmp/entries"
    for f in dist/cli.js web/dist/index.html harnesses/bare.json example-runs/bench-example.json; do
      grep -qxF -- "package/$f" "$tmp/entries" || { echo "missing: $f"; return 1; }
    done
  }
  h_leaks() {
    local hit email
    mkdir "$tmp/unpacked" && tar xzf "$tgz" -C "$tmp/unpacked"
    hit=$(grep -rlE '/Users/|/home/|/var/folders|/private/var|sk-ant-|sk-or-|Bearer [A-Za-z0-9._-]{16,}' "$tmp/unpacked" || true)
    [ -z "$hit" ] || { echo "path, key or bearer in: $(printf '%s' "$hit" | head -n 3 | tr '\n' ' ')"; return 1; }
    hit=$(grep -rlF -- "$(id -un)" "$tmp/unpacked" || true)
    [ -z "$hit" ] || { echo "the user name is in: $(printf '%s' "$hit" | head -n 3 | tr '\n' ' ')"; return 1; }
    email=$(git -C "$repo" config user.email || true)
    if [ -n "$email" ]; then
      hit=$(grep -rlF -- "$email" "$tmp/unpacked" || true)
      [ -z "$hit" ] || { echo "the git email is in: $(printf '%s' "$hit" | head -n 3 | tr '\n' ' ')"; return 1; }
    fi
  }
  h_sums() {
    echo "sha256 $(shasum -a 256 "$tgz" | cut -d' ' -f1)"
    echo "sha1   $(shasum "$tgz" | cut -d' ' -f1)"
  }
  h_docker() {
    docker info > /dev/null 2>&1 || { echo "start Docker Desktop"; return 1; }
  }

  step tarball-and-clean-repo h_tree
  step tarball-contents h_entries
  step no-machine-or-account-ids h_leaks
  h_sums
  step docker h_docker

  if docker info > /dev/null 2>&1; then
    local rc=0 abs
    abs=$(cd "$(dirname "$tgz")" && pwd)/$(basename "$tgz")
    set +e
    docker run --rm -e OPENROUTER_API_KEY -e ANTHROPIC_API_KEY -e OPENROUTER_MODEL \
      -v "$abs":/t/pkg.tgz:ro -v "$here/launch-check.sh":/t/launch-check.sh:ro \
      node:22.12-slim bash /t/launch-check.sh --inside /t/pkg.tgz 2>&1 | tee "$tmp/inside"
    rc=${PIPESTATUS[0]}
    set -e
    # the container ends with its own verdict line; its steps count into ours
    fails=$((fails + $(grep -c '^FAIL ' "$tmp/inside" || true)))
    skips=$((skips + $(grep -c '^SKIP ' "$tmp/inside" || true)))
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ] && ! grep -q '^FAIL ' "$tmp/inside"; then
      echo "FAIL container: docker run exited $rc"
      fails=$((fails + 1))
    fi
  fi
  finish
}

# ---------------------------------------------------------------- container mode

inside() {
  local tgz=$1 app=/tmp/app version bin="npx --no-install llm-harness-builder"
  mkdir -p "$app" && cd "$app" && npm init -y > /dev/null
  local pkgdir=$app/node_modules/llm-harness-builder

  c_node() { case $(node -v) in v22.12.*) ;; *) echo "node is $(node -v)"; return 1 ;; esac; }
  c_install() {
    local out
    out=$(npm i "$tgz" 2>&1) || { printf '%s\n' "$out" | tail -n 3; return 1; }
    case $out in *EBADENGINE*) echo "EBADENGINE in npm i"; return 1 ;; esac
  }
  c_version() {
    local want got h
    want=$(tar xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')
    got=$($bin --version)
    [ "$got" = "$want" ] || { echo "--version is $got, the tarball is $want"; return 1; }
    h=$($bin --help)
    for w in serve run demo bench replay analyze proxy; do
      printf '%s' "$h" | grep -qw -- "$w" || { echo "--help does not name $w"; return 1; }
    done
  }
  c_demo_nosrv() {
    local err rc=0
    err=$($bin demo 2>&1 > /dev/null) || rc=$?
    [ "$rc" -eq 1 ] || { echo "demo exited $rc, expected 1"; return 1; }
    case $err in *"ollama serve"*) ;; *) echo "stderr does not mention ollama serve"; return 1 ;; esac
  }
  c_serve() {
    local pid port="" i get
    $bin serve --no-open --port 0 2> serve.err > /dev/null &
    pid=$!
    for i in $(seq 1 60); do
      port=$(sed -n 's|.*serving on http://localhost:\([0-9][0-9]*\).*|\1|p' serve.err | head -n 1)
      [ -n "$port" ] && break
      sleep 0.5
    done
    if [ -z "$port" ]; then kill "$pid" 2> /dev/null || true; echo "no 'serving on' line in 30 s"; return 1; fi
    get="fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t))"
    local runs bench rc=0
    runs=$(node -e "$get" "http://localhost:$port/api/runs?example=1") || rc=1
    bench=$(node -e "$get" "http://localhost:$port/api/bench?example=1&file=bench-example.json") || rc=1
    kill "$pid" 2> /dev/null || true
    [ "$rc" -eq 0 ] || { echo "fetch failed"; return 1; }
    for id in d63e9548 590eb245 059867d3 6f1fb37b; do
      case $runs in *"$id"*) ;; *) echo "/api/runs?example=1 lacks $id"; return 1 ;; esac
    done
    case $bench in *'"result"'*) ;; *) echo "bench-example.json has no result"; return 1 ;; esac
    [ -f harnesses/bare.json ] || { echo "./harnesses/bare.json was not created"; return 1; }
  }
  c_analyze() {
    $bin analyze "$pkgdir/example-runs/bench-example.json" | grep d63e9548 | grep -q '1710 s' \
      || { echo "the d63e9548 row lacks '1710 s'"; return 1; }
  }
  c_openrouter() {
    printenv OPENROUTER_API_KEY > /dev/null 2>&1 || { echo "OPENROUTER_API_KEY not set"; return 77; }
    local model=${OPENROUTER_MODEL:-nvidia/nemotron-3.5-super-vl:free} out rc=0
    out=$($bin demo --kind openai --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY --model "$model" 2>&1) || rc=$?
    [ "$rc" -eq 0 ] || { echo "demo exited $rc; rerun with OPENROUTER_MODEL=<another :free id with tools> ($model)"; return 1; }
    [ "$(printf '%s\n' "$out" | grep -c 'trace=')" -eq 3 ] || { echo "not three rows with trace= (OPENROUTER_MODEL=$model)"; return 1; }
    ! printf '%s' "$out" | grep -q 'reason=backend_error' || { echo "reason=backend_error; rerun with another OPENROUTER_MODEL ($model)"; return 1; }
  }
  c_anthropic() {
    printenv ANTHROPIC_API_KEY > /dev/null 2>&1 || { echo "ANTHROPIC_API_KEY not set"; return 77; }
    local out rc=0
    out=$($bin bench "$pkgdir/harnesses/native-anthropic.json" --n 1 --timeout 300 2>&1) || rc=$?
    [ "$rc" -eq 0 ] || { echo "bench exited $rc"; return 1; }
    printf '%s' "$out" | grep -qF 'med $' || { echo "the bench table lacks 'med \$'"; return 1; }
    ! printf '%s' "$out" | grep -q 'backend_error' || { echo "the run ended in backend_error"; return 1; }
  }
  c_links() {
    local u
    for u in https://github.com/bambooplanedev/llm-harness-builder \
      https://github.com/bambooplanedev/llm-harness-builder/tree/main/docs/lab \
      https://github.com/bambooplanedev/llm-harness-builder/blob/main/docs/lab/README.uk.md; do
      node -e 'fetch(process.argv[1]).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))' "$u" || { echo "not 200: $u"; return 1; }
    done
  }
  c_keys() {
    local name where=""
    for name in OPENROUTER_API_KEY ANTHROPIC_API_KEY; do
      printenv "$name" | grep -q . || continue
      if grep -rqF -f <(printenv "$name") runs /tmp/launch.log 2> /dev/null; then
        where="$where $name"
      fi
    done
    [ -z "$where" ] || { echo "key found in runs/ or the log:$where"; return 1; }
  }

  step node c_node
  step npm-install c_install
  step version-and-help c_version
  step demo-without-server c_demo_nosrv
  step serve-and-example-runs c_serve
  step analyze c_analyze
  step openrouter c_openrouter
  step anthropic c_anthropic
  step links c_links
  step no-key-in-logs c_keys
  finish
}

if [ "${1:-}" = "--inside" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 --inside pkg.tgz" >&2; exit 2; }
  set +e
  inside "$2" 2>&1 | tee /tmp/launch.log
  exit "${PIPESTATUS[0]}"
fi
[ -n "${1:-}" ] || { echo "usage: $0 path/to/llm-harness-builder-X.Y.Z.tgz" >&2; exit 2; }
host "$1"
