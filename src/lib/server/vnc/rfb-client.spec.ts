import { describe, expect, it } from "vitest";
import { reverseBits, vncEncryptChallenge } from "./rfb-client.ts";

describe("reverseBits", () => {
	const cases: [input: number, want: number][] = [
		[0x00, 0x00],
		[0xff, 0xff],
		[0x01, 0x80],
		[0x80, 0x01],
		[0xaa, 0x55],
	];
	for (const [input, want] of cases) {
		it(`reverses 0x${input.toString(16).padStart(2, "0")}`, () =>
			expect(reverseBits(input)).toBe(want));
	}
});

describe("vncEncryptChallenge", () => {
	const challenge = Buffer.alloc(16, 0x2a);

	it("returns a 16-byte response", () => {
		expect(vncEncryptChallenge("secret", challenge).length).toBe(16);
	});

	it("is deterministic for the same inputs", () => {
		const a = vncEncryptChallenge("hunter2", challenge);
		const b = vncEncryptChallenge("hunter2", challenge);
		expect(a.equals(b)).toBe(true);
	});

	it("differs for different passwords", () => {
		const a = vncEncryptChallenge("alpha", challenge);
		const b = vncEncryptChallenge("bravo", challenge);
		expect(a.equals(b)).toBe(false);
	});

	it("uses only the first 8 characters of the password", () => {
		const a = vncEncryptChallenge("abcdefgh", challenge);
		const b = vncEncryptChallenge("abcdefghIGNORED", challenge);
		expect(a.equals(b)).toBe(true);
	});

	it("encrypts the two 8-byte halves independently (ECB)", () => {
		// A challenge of two identical 8-byte halves yields two identical cipher halves.
		const halves = Buffer.concat([
			Buffer.alloc(8, 0x11),
			Buffer.alloc(8, 0x11),
		]);
		const out = vncEncryptChallenge("pw", halves);
		expect(out.subarray(0, 8).equals(out.subarray(8, 16))).toBe(true);
	});
});
