#!/bin/bash
# Host-side driver for the entry-isolation forensics rig.
#
#   scripts/ssh-broker/probe/build-and-run.sh
#
# Stages the build context (packed plugin tarball + repo scripts the probe
# imports), builds the image, and runs the container. The container needs
# --privileged: bubblewrap creates user+mount namespaces, which Docker's
# default seccomp/namespace policy denies even to unprivileged images. The
# privilege relaxes ONLY the container boundary — inside, the probe runs as
# the unprivileged dshhost account and the Agent entries run under the same
# upstream bwrap confinement a real deployment enforces.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(git rev-parse --show-toplevel 2>/dev/null || { cd ../../.. && pwd; })
IMAGE=dsh-entry-isolation-probe:latest

rm -rf .build out
mkdir -p .build/scripts out

echo "[probe] packing plugin tarball"
TARBALL=$(cd "$REPO" && pnpm pack 2>/dev/null | tail -1)
cp "$REPO/$TARBALL" .build/plugin.tgz
rm -f "$REPO/$TARBALL"
[ -f .build/plugin.tgz ] || { echo "[probe] tarball staging failed" >&2; ls -la .build; exit 1; }

cp "$REPO"/scripts/probe-remote-entry-isolation.mjs .build/scripts/
cp -r "$REPO"/scripts/lib .build/scripts/lib

echo "[probe] docker build"
docker build -t "$IMAGE" .

echo "[probe] docker run (privileged: bwrap needs user+mount namespaces)"
docker run --rm --privileged -v "$PWD/out:/probe-out" "$IMAGE"

echo "[probe] evidence written to $(pwd)/out/"
ls -la out/
