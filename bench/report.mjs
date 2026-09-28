// Turn bench/results/metrics.csv into a Markdown comparison table (stdout, for
// the GitHub Step Summary) and, best-effort, PNG bar charts via gnuplot (for
// artifacts). Numbers are relative rankings on shared CI runners, not absolute.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const results = arg("results", "bench/results");
const metricsPath = `${results}/metrics.csv`;

const rows = fs
	.readFileSync(metricsPath, "utf8")
	.trim()
	.split("\n")
	.slice(1)
	.map((l) => l.split(","));

// data[client][workload.metric] = value
const data = {};
for (const [client, workload, metric, value] of rows) {
	if (!data[client]) data[client] = {};
	data[client][`${workload}.${metric}`] = value;
}

const CLIENTS = ["relay", "tigervnc", "remmina"].filter((c) => data[c]);
const LABEL = { relay: "Relay", tigervnc: "TigerVNC", remmina: "Remmina" };

const get = (c, k) => data[c]?.[k] ?? "NA";
const bytesToMb = (v) => (v === "NA" ? "NA" : (Number(v) / 1e6).toFixed(2));

const COLS = [
	["Latency median (ms) ↓", (c) => get(c, "latency.median_ms")],
	["Latency p95 (ms) ↓", (c) => get(c, "latency.p95_ms")],
	["Motion CPU (s) ↓", (c) => get(c, "motion.cpu_seconds")],
	["Motion peak RAM (MB) ↓", (c) => get(c, "motion.peak_rss_mb")],
	["Idle RAM (MB) ↓", (c) => get(c, "idle.peak_rss_mb")],
	["RFB traffic (MB) ↓", (c) => bytesToMb(get(c, "motion.rfb_bytes"))],
	["Time-to-first-frame (ms) ↓", (c) => get(c, "connect.ttff_ms")],
];

const lines = [
	"## VNC client benchmark — Relay vs TigerVNC vs Remmina",
	"",
	`| Metric | ${CLIENTS.map((c) => LABEL[c]).join(" | ")} |`,
	`|---|${CLIENTS.map(() => "--:").join("|")}|`,
];
for (const [name, fn] of COLS) {
	lines.push(`| ${name} | ${CLIENTS.map((c) => fn(c)).join(" | ")} |`);
}
lines.push(
	"",
	"> **Read these as relative rankings, not absolute truth.** Shared GitHub runner VMs (no GPU, noisy neighbours); latency is capture-bounded (ffmpeg x11grab), so treat it as ordering, not glass-to-glass ms.",
	">",
	"> **Fairness notes:** Relay's cost is the Chromium tab **plus** the Node bridge (RFB decode + WebSocket hop); the native viewers are ~one process — so Relay's RAM is expected to be higher (browser baseline). Idle vs motion RAM is shown so the fixed browser overhead is visible. Peak RAM is a peak-of-sampled-sum. RFB traffic is server↔client bytes on loopback (for Relay, server↔bridge), reflecting encoding efficiency, not WAN. Encoding: Relay + TigerVNC use ZRLE; Remmina negotiates its own (annotated).",
);

process.stdout.write(`${lines.join("\n")}\n`);

// --- charts (best-effort) ------------------------------------------------
const gnuplotAvailable =
	spawnSync("gnuplot", ["--version"], { stdio: "ignore" }).status === 0;

const barChart = (file, title, ylabel, pairs) => {
	const numeric = pairs.filter(
		([, v]) => v !== "NA" && !Number.isNaN(Number(v)),
	);
	if (!numeric.length) return;
	const dataLines = numeric.map(([c, v]) => `${LABEL[c] ?? c} ${v}`).join("\n");
	const script = `set terminal pngcairo size 700,420
set output '${results}/${file}'
set style data histograms
set style fill solid 0.7 border -1
set boxwidth 0.6
set grid ytics
set key off
set title '${title}'
set ylabel '${ylabel}'
plot '-' using 2:xtic(1)
${dataLines}
e
`;
	spawnSync("gnuplot", [], {
		input: script,
		stdio: ["pipe", "ignore", "ignore"],
	});
};

if (gnuplotAvailable) {
	barChart(
		"chart-latency.png",
		"Appearance latency (median ms) — lower is better",
		"ms",
		CLIENTS.map((c) => [c, get(c, "latency.median_ms")]),
	);
	barChart(
		"chart-cpu.png",
		"Motion CPU seconds — lower is better",
		"s",
		CLIENTS.map((c) => [c, get(c, "motion.cpu_seconds")]),
	);
	barChart(
		"chart-ram.png",
		"Motion peak RAM (MB) — lower is better",
		"MB",
		CLIENTS.map((c) => [c, get(c, "motion.peak_rss_mb")]),
	);
	barChart(
		"chart-bandwidth.png",
		"RFB traffic (MB) — lower is better",
		"MB",
		CLIENTS.map((c) => [c, bytesToMb(get(c, "motion.rfb_bytes"))]),
	);
	process.stderr.write("[report] wrote charts to " + results + "\n");
} else {
	process.stderr.write("[report] gnuplot not found; skipping charts\n");
}
