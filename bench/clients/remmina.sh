#!/usr/bin/env bash
# Remmina native GTK viewer (best-effort headless). DISPLAY set by the harness.
export NO_AT_BRIDGE=1
export GSETTINGS_BACKEND=memory
prof="${RESULTS:-bench/results}/bench.remmina"
cat >"$prof" <<'EOF'
[remmina]
name=vnc-bench
protocol=VNC
server=127.0.0.1:5900
quality=9
colordepth=32
disableserverbell=1
disableclipboard=1
disablepasswordstoring=1
viewmode=1
EOF
# Remmina needs a session bus; keep it in the foreground so the harness can
# track/kill the whole process group.
exec dbus-run-session -- remmina -c "$prof"
