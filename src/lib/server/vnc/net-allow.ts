import net from "node:net";

/**
 * Whether a target host may be reached by the VNC bridge / reachability probe.
 *
 * Only loopback and RFC 1918 private ranges are allowed, and only as bare IP
 * literals. Hostnames are rejected outright: the callers pass the value to
 * `net.connect`, which resolves names via DNS, so a name like
 * `10.0.0.1.evil.com` could pass a naive prefix check yet resolve anywhere
 * (SSRF / DNS-rebinding). `localhost` is the single allowed name.
 */
export function isAllowedHost(host: string): boolean {
	if (host === "localhost") return true;
	const kind = net.isIP(host);
	if (kind === 0) return false; // not an IP literal
	if (kind === 6) return host === "::1"; // only IPv6 loopback
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	return false;
}

/** A TCP port is a positive integer in 1..65535. */
export function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}
