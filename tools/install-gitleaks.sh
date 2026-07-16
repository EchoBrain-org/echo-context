#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: install-gitleaks.sh <output-directory>" >&2
  exit 2
fi

version=8.30.1
os=$(uname -s | tr '[:upper:]' '[:lower:]')
machine=$(uname -m)
case "$machine" in
  arm64|aarch64) archive_arch=arm64; contract_arch=arm64 ;;
  x86_64|amd64) archive_arch=x64; contract_arch=x64 ;;
  *) echo "unsupported gitleaks architecture: $machine" >&2; exit 1 ;;
esac
case "$os-$archive_arch" in
  darwin-arm64) archive_sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  darwin-x64) archive_sha=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  linux-arm64) archive_sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  linux-x64) archive_sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  *) echo "unsupported gitleaks platform: $os-$archive_arch" >&2; exit 1 ;;
esac

out=$1
mkdir -p "$out"
archive="$out/gitleaks.tar.gz"
case "$os" in
  darwin) archive_os=darwin ;;
  linux) archive_os=linux ;;
  *) echo "unsupported gitleaks OS: $os" >&2; exit 1 ;;
esac
url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${archive_os}_${archive_arch}.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-redirs 3 "$url" --output "$archive"
actual_archive_sha=$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$archive")
if [ "$actual_archive_sha" != "$archive_sha" ]; then
  echo "gitleaks archive digest mismatch" >&2
  exit 1
fi
tar -xzf "$archive" -C "$out" gitleaks
tool_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
expected_binary_sha=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.binary_sha256[process.argv[2]]||"")' "$tool_dir/secret-scan-contract.json" "$os-$contract_arch")
actual_binary_sha=$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$out/gitleaks")
if [ -z "$expected_binary_sha" ] || [ "$actual_binary_sha" != "$expected_binary_sha" ]; then
  echo "gitleaks binary digest mismatch" >&2
  exit 1
fi
rm -f "$archive"
"$out/gitleaks" version | grep -Fx "$version" >/dev/null
printf '%s\n' "$out/gitleaks"
