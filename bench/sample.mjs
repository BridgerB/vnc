// Sample a process group's summed RSS (peak) and CPU over a fixed window, by
// reading /proc/<pid>/stat and filtering on pgrp. Root-free and uniform across
// clients: for vnc the group is the Node preview + Chromium tree; for a native
// viewer it's the single process. Appends metrics for the run.
//
// Peak RSS is a peak-of-summed-samples (misses sub-interval spikes) — documented
// as such. CPU assumes the standard 100 Hz clock tick.

import fs from "node:fs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};

const name = arg("name", "unknown");
const workload = arg("workload", "motion");
const pgid = Number(arg("pgid", "0"));
const durationS = Number(arg("duration", "20"));
const intervalMs = Number(arg("interval", "200"));
const results = arg("results", "bench/results");
const metrics = `${results}/metrics.csv`;

const CLK_TCK = 100;
const PAGE = 4096;

// Returns { rssBytes, cpuTicks } summed over the process group, or null fields.
const sampleGroup = () => {
	let rss = 0;
	let cpu = 0;
	let found = 0;
	let pids;
	try {
		pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
	} catch {
		return { rssBytes: 0, cpuTicks: 0, found: 0 };
	}
	for (const pid of pids) {
		let s;
		try {
			s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			continue; // process vanished
		}
		const close = s.lastIndexOf(")");
		if (close < 0) continue;
		const rest = s.slice(close + 2).split(" ");
		// rest[0]=state(f3); field N -> rest[N-3]
		const pgrp = Number(rest[2]); // f5
		if (pgrp !== pgid) continue;
		const utime = Number(rest[11]); // f14
		const stime = Number(rest[12]); // f15
		const rssPages = Number(rest[21]); // f24
		cpu += utime + stime;
		rss += rssPages * PAGE;
		found++;
	}
	return { rssBytes: rss, cpuTicks: cpu, found };
};

let peakRss = 0;
let firstCpu = null;
let lastCpu = 0;
let sawProcs = false;

const tick = () => {
	const { rssBytes, cpuTicks, found } = sampleGroup();
	if (found > 0) sawProcs = true;
	if (rssBytes > peakRss) peakRss = rssBytes;
	if (firstCpu === null) firstCpu = cpuTicks;
	lastCpu = cpuTicks;
};

tick();
const timer = setInterval(tick, intervalMs);
setTimeout(() => {
	clearInterval(timer);
	tick();
	const rssMb = (peakRss / (1024 * 1024)).toFixed(1);
	const cpuS = ((lastCpu - (firstCpu ?? 0)) / CLK_TCK).toFixed(2);
	if (!sawProcs) {
		fs.appendFileSync(
			metrics,
			`${name},${workload},peak_rss_mb,NA,MB,no process group ${pgid}\n`,
		);
	} else {
		fs.appendFileSync(
			metrics,
			`${name},${workload},peak_rss_mb,${rssMb},MB,peak-of-sum @${intervalMs}ms\n` +
				`${name},${workload},cpu_seconds,${cpuS},s,over ${durationS}s window\n`,
		);
	}
	console.error(
		`[sample] ${name}/${workload}: peakRSS ${rssMb}MB cpu ${cpuS}s (procs seen: ${sawProcs})`,
	);
	process.exit(0);
}, durationS * 1000);
