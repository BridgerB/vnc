// Appearance-latency probe: flip the server's root colour and measure how long
// until the change shows up on a client's display. One ffmpeg x11grab process
// streams a 1x1 region of the client display; Node drives the flips and times
// first-appearance. Resolution is capture-bounded (~1/framerate) — report
// distributions and treat as RELATIVE across clients, not absolute glass-to-glass.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};

const clientName = arg("client", "unknown");
const clientDisplay = arg("client-display", ":101");
const serverDisplay = arg("server-display", ":99");
const px = arg("px", "640");
const py = arg("py", "360");
const reps = Number(arg("reps", "30"));
const results = arg("results", "bench/results");
const metrics = `${results}/metrics.csv`;

const DARK = "#101010";
const LIGHT = "#f0f0f0";
const MID = 380; // r+g+b threshold (0..765)
const FRAMERATE = 120;
const TIMEOUT_MS = 4000;

let current = 0;
let waiters = [];
const notify = () => {
	const pending = waiters;
	waiters = [];
	for (const w of pending) w();
};

const ff = spawn("ffmpeg", [
	"-loglevel",
	"quiet",
	"-f",
	"x11grab",
	"-framerate",
	String(FRAMERATE),
	"-video_size",
	"1x1",
	"-i",
	`${clientDisplay}+${px},${py}`,
	"-pix_fmt",
	"rgb24",
	"-f",
	"rawvideo",
	"-",
]);
let buf = Buffer.alloc(0);
ff.stdout.on("data", (d) => {
	buf = buf.length ? Buffer.concat([buf, d]) : d;
	while (buf.length >= 3) {
		current = buf[0] + buf[1] + buf[2];
		buf = buf.subarray(3);
	}
	notify();
});
ff.on("error", (e) => {
	console.error(`[latency] ffmpeg failed: ${e.message}`);
	process.exit(0); // don't fail the whole run; record N/A
});

const flip = (color) =>
	spawn("xsetroot", ["-solid", color], {
		env: { ...process.env, DISPLAY: serverDisplay },
		stdio: "ignore",
	});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitBrightness = (want) =>
	new Promise((resolve) => {
		const ok = () => (want === "light" ? current > MID : current < MID);
		if (ok()) return resolve(true);
		const to = setTimeout(() => resolve(false), TIMEOUT_MS);
		const check = () => {
			if (ok()) {
				clearTimeout(to);
				resolve(true);
			} else {
				waiters.push(check);
			}
		};
		waiters.push(check);
	});

const run = async () => {
	await sleep(600); // let ffmpeg attach
	flip(DARK);
	await waitBrightness("dark");
	await sleep(300);

	const samples = [];
	for (let i = 0; i < reps; i++) {
		const toLight = i % 2 === 0;
		// Start the clock, THEN fire the flip async so the pixel stream keeps
		// draining while it applies — otherwise a fast client transitions during a
		// blocking call and reads ~0ms.
		const t0 = performance.now();
		flip(toLight ? LIGHT : DARK);
		const got = await waitBrightness(toLight ? "light" : "dark");
		const t1 = performance.now();
		if (got) samples.push(t1 - t0);
		await sleep(250);
	}
	ff.kill("SIGKILL");

	if (!samples.length) {
		fs.appendFileSync(
			metrics,
			`${clientName},latency,median_ms,NA,ms,no frames detected\n` +
				`${clientName},latency,p95_ms,NA,ms,no frames detected\n`,
		);
		return;
	}
	samples.sort((a, b) => a - b);
	const at = (q) =>
		samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
	const median = at(0.5).toFixed(1);
	const p95 = at(0.95).toFixed(1);
	fs.appendFileSync(
		metrics,
		`${clientName},latency,median_ms,${median},ms,x11grab@${FRAMERATE}fps n=${samples.length}\n` +
			`${clientName},latency,p95_ms,${p95},ms,x11grab@${FRAMERATE}fps\n`,
	);
	fs.writeFileSync(
		`${results}/latency-${clientName}.csv`,
		`ms\n${samples.map((s) => s.toFixed(2)).join("\n")}\n`,
	);
	console.error(
		`[latency] ${clientName}: median ${median}ms p95 ${p95}ms (n=${samples.length})`,
	);
};

run().then(() => process.exit(0));
