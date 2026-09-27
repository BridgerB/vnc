/**
 * Persistence for saved connection profiles and viewer settings, backed by
 * localStorage. All accessors are SSR-safe (no-op when `window` is absent) and
 * defensive against corrupt/blocked storage.
 */

import type { Profile, Settings } from "$lib/types";

const PROFILES_KEY = "vnc.profiles";
const SETTINGS_KEY = "vnc.settings";

const hasStorage = () => typeof localStorage !== "undefined";

function read<T>(key: string, fallback: T): T {
	if (!hasStorage()) return fallback;
	try {
		const v = localStorage.getItem(key);
		return v ? (JSON.parse(v) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown) {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* quota / private mode — ignore */
	}
}

export function loadProfiles(): Profile[] {
	return read<Profile[]>(PROFILES_KEY, []);
}

/** Merge a partial update into a saved profile by id, then persist. */
export function updateProfile(id: string, patch: Partial<Profile>): Profile[] {
	const list = loadProfiles();
	const i = list.findIndex((p) => p.id === id);
	if (i < 0) return list;
	list[i] = { ...list[i], ...patch };
	saveProfiles(list);
	return list;
}

export function saveProfiles(profiles: Profile[]) {
	write(PROFILES_KEY, profiles);
}

export const defaultSettings: Settings = {
	scaleMode: "fit",
	viewOnly: false,
	autoReconnect: true,
	showStats: true,
	quality: 8, // 0-9 (Tight JPEG quality hint)
	compression: 2, // 0-9 (compression hint)
	clipboardSync: true,
	localCursor: true, // draw client-side cursor from the Cursor pseudo-encoding
};

export function loadSettings(): Settings {
	return { ...defaultSettings, ...read<Partial<Settings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(settings: Settings) {
	write(SETTINGS_KEY, settings);
}

export function newId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
