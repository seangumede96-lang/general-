#!/usr/bin/env bash
# Run every test in Firefox Nightly, plus web-ext lint. Needs root (the mock
# X server listens on port 443). Extra arguments go to pytest, e.g.
#   tests/run.sh -k collections        # just the collection tests
#   tests/run.sh -x                    # stop at the first failure
set -e
cd "$(dirname "$0")"
exec python3 -m pytest -q "$@"
