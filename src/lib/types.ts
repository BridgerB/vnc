/**
 * Shared domain types for vnc. Plain data only (CODE_STYLE §1/§3): every value
 * here survives JSON, localStorage, and the WebSocket wire without a prototype.
 */

/** Transport a connection speaks. */
export type ConnectionKind = "vnc" | "stream";

/** How the framebuffer is fitted into the viewport. */
export type ScaleMode = "fit" | "actual" | "stretch";

/** Where a viewer is in its connection lifecycle. */
export type ConnStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "closed"
	| "error";

/** A saved connection profile (persisted to localStorage). */
export interface Profile {
	id: string;
	name: string;
	host: string;
	port: number;
	password?: string;
	kind?: ConnectionKind;
	tags?: string[];
	width?: number;
	height?: number;
	lastConnected?: number;
	thumbnail?: string;
}

/** Viewer + session preferences (persisted to localStorage). */
export interface Settings {
	scaleMode: ScaleMode;
	viewOnly: boolean;
	autoReconnect: boolean;
	showStats: boolean;
	quality: number;
	compression: number;
	clipboardSync: boolean;
	localCursor: boolean;
}

/** A connection request: a saved profile, a quick-connect, or the defaults. */
export interface Target {
	id?: string;
	name?: string;
	host: string;
	port: number;
	password?: string;
	kind?: ConnectionKind;
}

/** Live throughput counters shown in the session HUD. */
export interface Stats {
	fps: number;
	kbps: number;
}

/** Status update a viewer emits up to its Session shell. */
export interface StatusEvent {
	status: ConnStatus;
	error?: string;
	name?: string;
	width?: number;
	height?: number;
}

/** Emitted once the framebuffer dimensions are known. */
export interface ConnectedInfo {
	width: number;
	height: number;
}

/**
 * The imperative surface a Session drives, implemented by both VncViewer and
 * StreamViewer so the shell can hold either behind one reference.
 */
export interface Viewer {
	connect(): void;
	disconnect(): void;
	sendKeys(keysyms: number[]): void;
	sendCtrlAltDel(): void;
	pasteClipboard(): void;
	refresh(): void;
	screenshot(): void;
	toggleFullscreen(): void;
	thumbnail(width?: number): string | null;
}
