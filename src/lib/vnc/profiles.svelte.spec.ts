import { beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "$lib/types";
import {
	defaultSettings,
	loadProfiles,
	loadSettings,
	newId,
	saveProfiles,
	saveSettings,
	updateProfile,
} from "./profiles.ts";

const sample = (over: Partial<Profile> = {}): Profile => ({
	id: "p1",
	name: "Box",
	host: "10.0.0.5",
	port: 5900,
	...over,
});

beforeEach(() => localStorage.clear());

describe("newId", () => {
	it("returns a non-empty base36 string", () => {
		expect(newId()).toMatch(/^[a-z0-9]+$/);
	});
	it("returns a different id each call", () => {
		expect(newId()).not.toBe(newId());
	});
});

describe("defaultSettings", () => {
	it("has the expected defaults", () => {
		expect(defaultSettings.scaleMode).toBe("fit");
		expect(defaultSettings.quality).toBe(8);
		expect(defaultSettings.viewOnly).toBe(false);
		expect(defaultSettings.showStats).toBe(true);
		expect(defaultSettings.autoReconnect).toBe(true);
	});
});

describe("profiles persistence", () => {
	it("returns an empty list when nothing is stored", () => {
		expect(loadProfiles()).toEqual([]);
	});

	it("round-trips saved profiles", () => {
		const list = [sample(), sample({ id: "p2", name: "Two" })];
		saveProfiles(list);
		expect(loadProfiles()).toEqual(list);
	});

	it("merges a patch into a profile by id", () => {
		saveProfiles([sample()]);
		const updated = updateProfile("p1", {
			name: "Renamed",
			lastConnected: 123,
		});
		expect(updated[0]?.name).toBe("Renamed");
		expect(updated[0]?.lastConnected).toBe(123);
		expect(updated[0]?.host).toBe("10.0.0.5"); // untouched fields survive
		expect(loadProfiles()[0]?.name).toBe("Renamed"); // persisted
	});

	it("leaves the list unchanged for an unknown id", () => {
		saveProfiles([sample()]);
		expect(updateProfile("nope", { name: "X" })).toEqual([sample()]);
	});

	it("survives corrupt storage", () => {
		localStorage.setItem("vnc.profiles", "{not json");
		expect(loadProfiles()).toEqual([]);
	});
});

describe("settings persistence", () => {
	it("merges stored values over the defaults", () => {
		saveSettings({ ...defaultSettings, quality: 3, viewOnly: true });
		const s = loadSettings();
		expect(s.quality).toBe(3);
		expect(s.viewOnly).toBe(true);
		expect(s.scaleMode).toBe("fit"); // default preserved
	});

	it("returns defaults when nothing is stored", () => {
		expect(loadSettings()).toEqual(defaultSettings);
	});
});
