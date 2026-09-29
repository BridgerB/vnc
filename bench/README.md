# VNC client benchmark

Compares **Relay** against **TigerVNC** and **Remmina** on the same VNC server,
measuring latency, CPU, RAM, and bandwidth. It runs in GitHub Actions
(`.github/workflows/benchmark.yml`, manual **workflow_dispatch**) so the numbers
come off a neutral machine, not a dev laptop.

## How it works

- One fixed server: TigerVNC's `Xvnc` (`:99`, port 5900) — the reference RFB
  server, and it honours ContinuousUpdates (which Relay negotiates), unlike
  x11vnc whose weak push starves continuous-update clients and would be an unfair
  confound. Any client-side differences are attributable to the client.
- Each client runs **sequentially**, on its **own** Xvfb display, and connects to
  `127.0.0.1:5900`:
  - Relay — `vite preview` (Node bridge + RFB decode) + a headful Chromium tab
    driven by Playwright (`bench/clients/relay.sh`, `bench/relay-drive.mjs`).
  - TigerVNC — `xtigervncviewer` (`bench/clients/tigervnc.sh`).
  - Remmina — `remmina` + VNC plugin (`bench/clients/remmina.sh`, best-effort).
- Three workloads per client:
  - **idle + connect** — time-to-first-frame and idle RAM (static desktop).
  - **appearance latency** — flip the server root colour and time how long until
    it shows on the client's display (`bench/latency.mjs`, ffmpeg x11grab pixel
    probe). Median + p95 over many reps.
  - **motion** — `ffplay testsrc` animates the server; measure CPU, peak RAM, and
    RFB bytes under load.
- **CPU/RAM** are sampled from `/proc` across the client's whole process group
  (`bench/sample.mjs`) — for Relay that's Node **and** Chromium, so it's compared
  fairly against the single-process native viewers. **Bandwidth** is `tcpdump` on
  loopback (`bench/lib.sh`).
- `bench/report.mjs` renders the comparison table (Step Summary) and gnuplot
  charts + CSVs (artifacts).

## Running

- CI: Actions → **Benchmark** → *Run workflow* (inputs: `duration`, `reps`,
  optional `pr_number` to post the table on a PR).
- Locally on Linux (e.g. the NixOS box, via the flake devShell):
  `DURATION=20 REPS=30 npm run bench`.

Not runnable on macOS (Linux-only: Xvfb/x11vnc/native viewers).

## Fairness caveats (read before quoting numbers)

- **Relative, not absolute.** Shared CI VMs (no GPU, noisy neighbours) and
  capture-bounded latency (ffmpeg x11grab) mean these are rankings, not
  glass-to-glass milliseconds.
- **Relay is a browser + a bridge.** It carries a fixed Chromium baseline and an
  extra server→bridge→browser hop; native viewers are ~one process. Expect Relay
  to use **more RAM** — idle vs motion RAM is reported so the baseline is visible.
  Latency and CPU-under-load are where a browser client can be competitive.
- **Encoding is negotiated per client** (the biggest bandwidth confounder). Relay
  and TigerVNC use ZRLE; Remmina negotiates its own — annotated, not forced.
- **Peak RAM** is a peak-of-sampled-sum (200 ms) — it can miss sub-interval
  spikes. **CPU** assumes the standard 100 Hz clock tick.
- Loopback transport → bandwidth reflects encoding efficiency, not a real network.
