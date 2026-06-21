#!/usr/bin/env bash
# Thin bash wrapper — delegates to the Node.js implementation
exec node "$(dirname "$(realpath "$0")")/rlm-hook.mjs" "$@"
