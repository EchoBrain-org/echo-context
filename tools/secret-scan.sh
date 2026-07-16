#!/bin/sh
exec node "$(dirname "$0")/secret-scan.mjs" "$@"
