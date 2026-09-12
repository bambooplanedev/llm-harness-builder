#!/bin/sh
# examples/check.sh — exit 0 when the task is done
cd "$(dirname "$0")" && node --test >/dev/null 2>&1
