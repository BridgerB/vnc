/**
 * Pure parsers for the host/port strings people type into the dashboard.
 * No IO, no DOM — unit-tested in isolation (CODE_STYLE §2/§11).
 */

export interface HostPort {
	host: string;
	port: number;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Parse a "host" or "host:port" string. Returns null when the host is empty or
 * the port is out of range, so callers never act on a half-parsed value.
 */
export function parseHostPort(
	raw: string,
	defaultPort = 5900,
): HostPort | null {
	const s = raw.trim();
	if (!s) return null;
	const m = s.match(/^(.+):(\d{1,5})$/);
	const host = (m ? m[1] : s).trim();
	const port = m ? Number(m[2]) : defaultPort;
	if (!host || port < MIN_PORT || port > MAX_PORT) return null;
	return { host, port };
}

/**
 * Parse a quick-connect string, tolerating an "ssh-style" `user@` prefix (the
 * user part is not used — vnc authenticates to the remote, not over SSH).
 */
export function parseQuickConnect(
	raw: string,
	defaultPort = 5900,
): HostPort | null {
	const s = raw.trim();
	if (!s) return null;
	const at = s.includes("@") ? s.slice(s.indexOf("@") + 1) : s;
	return parseHostPort(at, defaultPort);
}
