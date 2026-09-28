#!/usr/bin/env bash
# Relay client = the SvelteKit preview (Node bridge + RFB decode) + a headful
# Chromium tab. Both run in this process group so the sampler counts the whole
# cost. DISPLAY (the client's Xvfb) is set by the harness.
set -e
RESULTS="${RESULTS:-bench/results}"
npm run preview >"$RESULTS/relay-preview.log" 2>&1 &
for _ in $(seq 1 120); do
	(exec 3<>/dev/tcp/127.0.0.1/4734) 2>/dev/null && break
	sleep 0.5
done
exec node bench/relay-drive.mjs
