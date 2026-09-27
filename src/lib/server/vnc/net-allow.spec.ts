import { describe, expect, it } from "vitest";
import { isAllowedHost, isValidPort } from "./net-allow.js";

describe("isAllowedHost", () => {
	const cases: [name: string, host: string, want: boolean][] = [
		["loopback literal", "127.0.0.1", true],
		["ipv6 loopback", "::1", true],
		["localhost name", "localhost", true],
		["10/8 private", "10.0.0.4", true],
		["192.168/16 private", "192.168.1.20", true],
		["172.16/12 low edge", "172.16.0.1", true],
		["172.31 high edge", "172.31.255.254", true],
		["172.15 just below range", "172.15.0.1", false],
		["172.32 just above range", "172.32.0.1", false],
		["public IP rejected", "8.8.8.8", false],
		["ssh-rebinding name rejected", "10.0.0.1.evil.com", false],
		["arbitrary hostname rejected", "evil.com", false],
		["empty rejected", "", false],
		["ipv6 non-loopback rejected", "fd00::1", false],
	];
	for (const [name, host, want] of cases) {
		it(name, () => expect(isAllowedHost(host)).toBe(want));
	}
});

describe("isValidPort", () => {
	const cases: [name: string, port: number, want: boolean][] = [
		["typical port", 5900, true],
		["low edge", 1, true],
		["high edge", 65535, true],
		["zero rejected", 0, false],
		["above range rejected", 70000, false],
		["NaN rejected", Number.NaN, false],
		["fractional rejected", 5900.5, false],
	];
	for (const [name, port, want] of cases) {
		it(name, () => expect(isValidPort(port)).toBe(want));
	}
});
