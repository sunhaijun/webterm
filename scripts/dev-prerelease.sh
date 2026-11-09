#!/usr/bin/env bash
# dev-prerelease.sh decides whether a Release run publishes the rolling `dev`
# prerelease (docs/80-ops/development.md#releases, AC-8.9). It only decides; the
# workflow asks GitHub for the inputs and publishes.
#
#   REF        the run's github.ref: refs/heads/main or refs/tags/v…
#   SHA        the commit the run built
#   MAIN_HEAD  main's head now
#   TAGS       the v* tags on SHA now, one per line
#   VERSION    what the built binary's `webterm version` prints
#
# Prints "publish", or "skip: <why>", and exits 0 either way.
set -euo pipefail

: "${REF:?}" "${SHA:?}" "${MAIN_HEAD:?}" "${VERSION:?}"
TAGS="${TAGS:-}"

case "$REF" in
    refs/heads/main)
        if [ "$SHA" != "$MAIN_HEAD" ]; then
            echo "skip: main has moved on to ${MAIN_HEAD:0:7}; its run publishes dev"
            exit 0
        fi
        # A tag pushed after this run checked the commit out: the binary reports the
        # previous release, and the tag's run publishes dev with the right version.
        while IFS= read -r tag; do
            [ -n "$tag" ] || continue
            if [ "$VERSION" != "webterm $tag" ]; then
                echo "skip: $tag was tagged after this build ($VERSION); the tag's run publishes dev"
                exit 0
            fi
        done <<<"$TAGS"
        echo publish
        ;;
    refs/tags/v*)
        if [ "$SHA" != "$MAIN_HEAD" ]; then
            echo "skip: ${REF#refs/tags/} isn't on main's head (${MAIN_HEAD:0:7})"
            exit 0
        fi
        echo publish
        ;;
    *)
        echo "skip: $REF publishes no dev"
        ;;
esac
