# shellcheck shell=bash
# Shared primitives for the VNC client benchmark. Sourced by run.sh.
# Requires: Xvfb, x11vnc, ffmpeg, tcpdump, xsetroot, systemd-run (cgroup v2).

SERVER_DISPLAY=:99
SERVER_GEOM=1280x720x24
VNC_PORT=5900
RESULTS="${RESULTS:-bench/results}"
METRICS="$RESULTS/metrics.csv"

# Packet capture needs root; use sudo only when we aren't already root (GitHub
# runners are non-root + passwordless sudo; a Docker container is root, no sudo).
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

log() { echo "[bench] $*" >&2; }

csv_init() {
	mkdir -p "$RESULTS"
	echo "client,workload,metric,value,unit,note" >"$METRICS"
}
# csv_add <client> <workload> <metric> <value> <unit> [note]
csv_add() {
	echo "$1,$2,$3,$4,$5,${6:-}" >>"$METRICS"
}

wait_port() {
	local host=$1 port=$2 timeout=${3:-30} i=0
	while ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; do
		i=$((i + 1))
		[ "$i" -ge "$((timeout * 5))" ] && return 1
		sleep 0.2
	done
	exec 3>&- 2>/dev/null || true
	return 0
}

# --- server (one fixed x11vnc on its own Xvfb) ---------------------------
start_server() {
	log "starting Xvfb $SERVER_DISPLAY + x11vnc :$VNC_PORT"
	Xvfb "$SERVER_DISPLAY" -screen 0 "$SERVER_GEOM" -nolisten tcp >"$RESULTS/xvfb-server.log" 2>&1 &
	SERVER_XVFB_PID=$!
	sleep 2
	DISPLAY="$SERVER_DISPLAY" xsetroot -solid "#202020" || true
	x11vnc -display "$SERVER_DISPLAY" -rfbport "$VNC_PORT" -localhost -nopw \
		-forever -shared -quiet -noxdamage -ncache 0 >"$RESULTS/x11vnc.log" 2>&1 &
	SERVER_X11VNC_PID=$!
	wait_port 127.0.0.1 "$VNC_PORT" 30 || {
		log "x11vnc did not open :$VNC_PORT"
		return 1
	}
	log "server up"
}
stop_server() {
	kill "$SERVER_X11VNC_PID" "$SERVER_XVFB_PID" 2>/dev/null || true
}

# --- per-client virtual display -----------------------------------------
start_display() { # <:N>  — prints the Xvfb pid. Redirect Xvfb's fds so it does
	# not hold the command-substitution pipe open (which would hang $(start_display)).
	Xvfb "$1" -screen 0 "$SERVER_GEOM" -nolisten tcp >/dev/null 2>&1 &
	echo $!
	sleep 1.5
}

# --- client process group (whole tree CPU/RAM, no root) -----------------
# client_start <display> <script> <logfile> -> prints the process-group leader
# pid. `setsid` puts the client (and its children — Node preview + Chromium, or
# the native viewer) in a fresh process group so the sampler can sum the tree.
client_start() {
	local display=$1 script=$2 logfile=$3
	setsid env DISPLAY="$display" bash "$script" >"$logfile" 2>&1 &
	echo $!
}
client_stop() { # <pgid-leader-pid>
	kill -TERM -- "-$1" 2>/dev/null || true
	sleep 1
	kill -KILL -- "-$1" 2>/dev/null || true
}
# sample_tree <name> <workload> <pgid> <duration-s> — samples the process group's
# summed RSS (peak) and CPU over the window, appends metrics via sample.mjs.
sample_tree() {
	node bench/sample.mjs --name "$1" --workload "$2" --pgid "$3" \
		--duration "$4" --results "$RESULTS"
}

# --- bandwidth (RFB bytes on loopback) ----------------------------------
tcpdump_start() { # <pcap-path> <port>
	$SUDO tcpdump -i lo -w "$1" -s 96 "tcp port $2" >/dev/null 2>&1 &
	echo $!
}
tcpdump_bytes() { # <pcap-path> -> total on-wire bytes (both directions)
	# frame.len is the original wire length even with a small snaplen, so summing
	# it gives true bandwidth; fall back to pcap file size if tshark is absent.
	if command -v tshark >/dev/null 2>&1; then
		$SUDO tshark -r "$1" -T fields -e frame.len 2>/dev/null |
			awk '{s+=$1} END {print s+0}'
	else
		stat -c%s "$1" 2>/dev/null || echo 0
	fi
}

# --- server-side stimulus ------------------------------------------------
# Continuous animation painted onto the server display so all clients see motion.
start_motion() {
	DISPLAY="$SERVER_DISPLAY" ffplay -loglevel quiet -fs -f lavfi \
		-i "testsrc=size=1280x720:rate=30" >/dev/null 2>&1 &
	echo $!
}
stop_motion() { kill "$1" 2>/dev/null || true; }
