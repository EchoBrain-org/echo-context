#!/bin/sh
set -eu

die() {
  printf '%s\n' "fresh-clone-acceptance: $1" >&2
  exit 2
}

case "$0" in
  /*) ;;
  *) die 'entrypoint must use its canonical absolute path' ;;
esac
case "$0" in
  *'
'*) die 'entrypoint path contains a newline' ;;
esac
[ -f "$0" ] && [ ! -L "$0" ] || die 'entrypoint must be a regular nonsymlink file'

original_pwd=$(pwd -P) || die 'cannot resolve physical cwd'
tools_raw=${0%/*}
[ "$tools_raw" != "$0" ] || die 'entrypoint has no tools directory'
cd -P "$tools_raw" || die 'cannot enter tools directory'
tools_dir=$(pwd -P) || die 'cannot resolve tools directory'
[ "$0" = "$tools_dir/fresh-clone-acceptance.sh" ] || die 'entrypoint contains a symlink or noncanonical component'
clone_raw=${tools_dir%/*}
cd -P "$clone_raw" || die 'cannot enter clone root'
clone_root=$(pwd -P) || die 'cannot resolve clone root'
[ "$tools_dir" = "$clone_root/tools" ] || die 'tools directory is not the clone-root child'
[ "$original_pwd" = "$clone_root" ] || die 'physical cwd must equal the clone root'
verifier="$tools_dir/fresh-clone-verifier.mjs"
[ -f "$verifier" ] && [ ! -L "$verifier" ] || die 'verifier sibling must be a regular nonsymlink file'

[ "$#" -ge 12 ] || die 'missing fixed common prefix or source arguments'
[ "$1" = '--node-bin' ] || die 'common prefix must begin with --node-bin'
node_bin=$2
shift 2
[ "$1" = '--npm-bin' ] || die 'common prefix requires --npm-bin second'
npm_bin=$2
shift 2
[ "$1" = '--git-bin' ] || die 'common prefix requires --git-bin third'
git_bin=$2
shift 2
[ "$1" = '--git-version' ] || die 'common prefix requires --git-version fourth'
git_version=$2
shift 2
[ "$1" = '--sandbox-home' ] || die 'common prefix requires --sandbox-home fifth'
sandbox_home=$2
shift 2

for value in "$node_bin" "$npm_bin" "$git_bin" "$sandbox_home"; do
  case "$value" in
    /*) ;;
    *) die 'tool and HOME values must be absolute' ;;
  esac
  case "$value" in
    *'
'*) die 'tool or HOME value contains a newline' ;;
  esac
done
case "$git_version" in
  ''|*'
'*) die 'git version is missing or contains a newline' ;;
esac
[ -f "$node_bin" ] && [ -x "$node_bin" ] && [ ! -L "$node_bin" ] || die 'NODE must be a regular executable nonsymlink file'
[ -f "$npm_bin" ] && [ -x "$npm_bin" ] && [ ! -L "$npm_bin" ] || die 'NPM must be a regular executable nonsymlink file'
[ -f "$git_bin" ] && [ -x "$git_bin" ] && [ ! -L "$git_bin" ] || die 'GIT must be a regular executable nonsymlink file'
[ -d "$sandbox_home" ] && [ ! -L "$sandbox_home" ] || die 'HOME must already be a nonsymlink directory'
[ -d "$sandbox_home/tmp" ] && [ ! -L "$sandbox_home/tmp" ] || die 'HOME/tmp must already be a nonsymlink directory'

node_dir=${node_bin%/*}
npm_dir=${npm_bin%/*}
git_dir=${git_bin%/*}
path_value="$node_dir:$npm_dir:$git_dir:/usr/bin:/bin"

exec /usr/bin/env -i \
  HOME="$sandbox_home" \
  TMPDIR="$sandbox_home/tmp" \
  PATH="$path_value" \
  LANG=C \
  LC_ALL=C \
  TZ=UTC \
  CI=1 \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_TERMINAL_PROMPT=0 \
  NPM_CONFIG_USERCONFIG=/dev/null \
  NPM_CONFIG_CACHE="$sandbox_home/.npm-cache" \
  "$node_bin" "$verifier" \
  --node-bin "$node_bin" \
  --npm-bin "$npm_bin" \
  --git-bin "$git_bin" \
  --git-version "$git_version" \
  --sandbox-home "$sandbox_home" \
  "$@"
