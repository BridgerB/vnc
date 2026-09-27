import { describe, expect, it } from "vitest";
import { keysymFromEvent } from "./keysym.ts";

const sym = (key: string) => keysymFromEvent({ key } as KeyboardEvent);

describe("keysymFromEvent", () => {
	const cases: [name: string, key: string, want: number][] = [
		["named: Enter", "Enter", 0xff0d],
		["named: Escape", "Escape", 0xff1b],
		["named: Delete", "Delete", 0xffff],
		["named: ArrowUp", "ArrowUp", 0xff52],
		["named: Control", "Control", 0xffe3],
		["named: space", " ", 0x0020],
		["function: F1", "F1", 0xffbe],
		["function: F24", "F24", 0xffbe + 23],
		["printable ascii: 'a'", "a", 0x61],
		["printable Latin-1: 'é'", "é", 0xe9],
		["printable beyond Latin-1: '€'", "€", 0x01000000 + 0x20ac],
	];
	for (const [name, key, want] of cases) {
		it(name, () => expect(sym(key)).toBe(want));
	}

	for (const key of ["F0", "F25", ""]) {
		it(`returns 0 for '${key}'`, () => expect(sym(key)).toBe(0));
	}
});
