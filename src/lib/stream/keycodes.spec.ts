import { describe, expect, it } from "vitest";
import { KEYCODES } from "./keycodes.ts";

describe("KEYCODES", () => {
	const cases: [code: string, want: number][] = [
		["Escape", 1],
		["Enter", 28],
		["KeyA", 30],
		["ControlLeft", 29],
		["Delete", 111],
	];
	for (const [code, want] of cases) {
		it(`maps ${code} -> ${want}`, () => expect(KEYCODES[code]).toBe(want));
	}

	it("has no entry for an unknown code", () => {
		expect(KEYCODES.NotARealKey).toBeUndefined();
	});

	it("maps every value to a distinct keycode", () => {
		const values = Object.values(KEYCODES);
		expect(new Set(values).size).toBe(values.length);
	});
});
