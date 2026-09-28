#!/usr/bin/env bash
# VNC client benchmark orchestrator: one fixed x11vnc server, then Relay,
# TigerVNC, and Remmina run sequentially through idle/latency/motion workloads.
# Metrics land in bench/results/metrics.csv; a report is printed to stdout.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=bench/lib.sh
source bench/lib.sh

DURATION="${DURATION:-20}"
REPS="${REPS:-30}"

csv_init
cleanup_stale
start_server || {
	log "server failed to start"
	exit 1
}
trap stop_server EXIT

log "building the app (outside measurement)"
npm run build >"$RESULTS/build.log" 2>&1 || {
	log "build failed"
	tail -20 "$RESULTS/build.log" >&2
	exit 1
}

run_client() {
	local name=$1 dispnum=$2 script=$3 px=$4 py=$5 ready=$6
	local disp=":$dispnum"
	log "=== client: $name on $disp ==="
	local xvfb_pid
	xvfb_pid=$(start_display "$disp")
	DISPLAY="$disp" openbox >/dev/null 2>&1 &
	local wm=$!
	sleep 1

	local clog="$RESULTS/$name-client.log"
	local leader
	leader=$(client_start "$disp" "$script" "$clog")
	log "$name process-group leader=$leader"

	# Wait for the connection to establish.
	local t0 t1
	t0=$(date +%s.%N)
	if [ "$ready" = "grep" ]; then
		# Chromium first paint is slow on a GPU-less runner; give it up to 120s.
		for _ in $(seq 1 240); do grep -q READY "$clog" 2>/dev/null && break; sleep 0.5; done
	else
		sleep 8
	fi
	t1=$(date +%s.%N)
	if grep -q READY "$clog" 2>/dev/null; then
		csv_add "$name" connect ttff_ms "$(awk "BEGIN{printf \"%.0f\",($t1-$t0)*1000}")" ms
	else
		csv_add "$name" connect ttff_ms NA ms "no READY (native viewer)"
	fi

	# Idle resource on a static desktop.
	DISPLAY="$SERVER_DISPLAY" xsetroot -solid "#202020" || true
	sample_tree "$name" idle "$leader" 5

	# Appearance latency.
	node bench/latency.mjs --client "$name" --client-display "$disp" \
		--px "$px" --py "$py" --reps "$REPS" --results "$RESULTS" ||
		log "latency probe failed for $name"

	# Motion: CPU/RAM under load + RFB bandwidth.
	local motion pcap td
	motion=$(start_motion)
	sleep 1
	pcap="$RESULTS/$name.pcap"
	td=$(tcpdump_start "$pcap" "$VNC_PORT")
	sleep 0.5
	sample_tree "$name" motion "$leader" "$DURATION"
	$SUDO kill "$td" 2>/dev/null || true
	sleep 1
	stop_motion "$motion"
	csv_add "$name" motion rfb_bytes "$(tcpdump_bytes "$pcap")" bytes

	client_stop "$leader"
	kill "$wm" "$xvfb_pid" 2>/dev/null || true
	sleep 1
}

run_client relay 103 bench/clients/relay.sh 640 360 grep
run_client tigervnc 101 bench/clients/tigervnc.sh 640 360 sleep
run_client remmina 102 bench/clients/remmina.sh 640 400 sleep

log "=== metrics.csv ==="
cat "$METRICS" >&2

node bench/report.mjs --results "$RESULTS" >"$RESULTS/report.md" || true
cat "$RESULTS/report.md"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	cat "$RESULTS/report.md" >>"$GITHUB_STEP_SUMMARY"
fi
