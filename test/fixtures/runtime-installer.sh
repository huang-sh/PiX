#!/bin/sh
set -eu
repo=$1
test_root=$(mktemp -d /tmp/pix-runtime-unit-XXXXXX)
trap 'rm -rf -- "$test_root"' EXIT
root="$test_root/server space"
mkdir -p "$root/versions" "$test_root/system bin" "$test_root/login bin"
cp "$repo/test/fixtures/runtime-login-shell" "$test_root/login-shell"
chmod 700 "$test_root/login-shell"
export SHELL="$test_root/login-shell"
export PIX_TEST_LOGIN_NODE=
original_path=$PATH

fake_node() {
  mkdir -p "$1"
  cp "$repo/test/fixtures/runtime-node" "$1/node"
  chmod 700 "$1/node"
  touch "$1/npm"
}
stage_install() {
  stage=$(mktemp -d "$root/.install-XXXXXX")
  mkdir -p "$stage/bin"
  touch "$stage/bin/check-runtime.mjs" "$stage/bin/pix-agent-host"
  target="$root/versions/$1"
}
install() { sh "$repo/server/bin/install-host" "$root" "$stage" "$target"; }
assert_node() { test "$(readlink -f "$root/current/node/bin/node")" = "$1"; }

fake_node "$test_root/system bin"
fake_node "$test_root/login bin"
export PATH="$test_root/system bin:/usr/bin:/bin"
stage_install system
install
assert_node "$test_root/system bin/node"
test ! -d "$root/runtime"
printf 'PASS: system Node reused without download, including spaces\n'

export PATH="$test_root/login bin:/usr/bin:/bin"
stage_install stable
install
assert_node "$test_root/system bin/node"
printf 'PASS: selected Node remains stable despite PATH changes\n'

stage_install login
printf '%s\n' "$test_root/system bin/node" > "$stage/.reject-node"
export PATH=/usr/bin:/bin
export PIX_TEST_LOGIN_NODE="$test_root/login bin/node"
timeout 3 sh "$repo/server/bin/install-host" "$root" "$stage" "$target"
assert_node "$test_root/login bin/node"
printf 'PASS: rejected current Node falls back to interactive login Node\n'

case $(uname -m) in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
private="$root/runtime/node-v24.18.0-linux-$arch/bin"
fake_node "$private"
stage_install private
printf '%s\n' "$test_root/login bin/node" > "$stage/.reject-node"
export PIX_TEST_LOGIN_NODE=
install
assert_node "$private/node"
printf 'PASS: cached fixed-version private runtime used as fallback\n'

previous=$(readlink -f "$root/current")
stage_install rejected
touch "$stage/.reject-all"
if install; then echo 'Expected runtime rejection' >&2; exit 1; fi
test "$(readlink -f "$root/current")" = "$previous"
test ! -e "$target"
printf 'PASS: failed checks leave current untouched\n'

if sh "$repo/server/bin/install-host" "$root" "$root/versions/private" "$root/versions/unsafe"; then exit 1; fi
test "$(readlink -f "$root/current")" = "$previous"
printf 'PASS: non-staging directory rejected\n'
export PATH=$original_path
