#!/bin/sh
# Point git at the versioned hooks in hooks/ (the pre-push scan and tests).
# core.hooksPath is stored in this clone's .git/config, so every fresh clone runs this once.
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath hooks
echo "core.hooksPath set to hooks/ for this clone"
