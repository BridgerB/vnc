import { describe, expect, it } from "vitest";
import { type HostPort, parseHostPort, parseQuickConnect } from "./parse.js";

describe("parseHostPort", () => {
	const cases: [name: string, input: string, want: HostPort | null][] = [
		[
			"bare host uses default port",
			"workstation",
			{ host: "workstation", port: 5900 },
		],
		["host with port", "10.0.0.4:5901", { host: "10.0.0.4", port: 5901 }],
		["hostname with port", "nas.local:5900", { host: "nas.local", port: 5900 }],
		[
			"surrounding whitespace trimmed",
			"  box:5902  ",
			{ host: "box", port: 5902 },
		],
		["empty string is null", "", null],
		["whitespace only is null", "   ", null],
		["port zero is out of range", "host:0", null],
		["port above 65535 is out of range", "host:70000", null],
	];
	for (const [name, input, want] of cases) {
		it(name, () => expect(parseHostPort(input)).toEqual(want));
	}

	it("honors a custom default port", () => {
		expect(parseHostPort("host", 4735)).toEqual({ host: "host", port: 4735 });
	});
});

describe("parseQuickConnect", () => {
	const cases: [name: string, input: string, want: HostPort | null][] = [
		[
			"strips ssh-style user prefix",
			"user@10.0.0.4:5901",
			{ host: "10.0.0.4", port: 5901 },
		],
		[
			"works without a user prefix",
			"10.0.0.4:5901",
			{ host: "10.0.0.4", port: 5901 },
		],
		[
			"bare host with user prefix",
			"root@workstation",
			{ host: "workstation", port: 5900 },
		],
		["empty string is null", "", null],
	];
	for (const [name, input, want] of cases) {
		it(name, () => expect(parseQuickConnect(input)).toEqual(want));
	}
});
