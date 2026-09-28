import { describe, expect, it } from "vitest";
import { desEncryptBlock } from "./des.ts";

const hex = (b: Uint8Array) =>
	[...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("desEncryptBlock", () => {
	it("matches the canonical FIPS-81 test vector", () => {
		// key 133457799BBCDFF1, plaintext 0123456789ABCDEF -> 85E813540F0AB405
		const key = Buffer.from("133457799bbcdff1", "hex");
		const pt = Buffer.from("0123456789abcdef", "hex");
		expect(hex(desEncryptBlock(key, pt))).toBe("85e813540f0ab405");
	});

	it("encrypts all-zero data under an all-zero key to a known value", () => {
		// Well-known DES vector: key 0, data 0 -> 8CA64DE9C1B123A7
		const zero = Buffer.alloc(8, 0);
		expect(hex(desEncryptBlock(zero, zero))).toBe("8ca64de9c1b123a7");
	});

	it("is deterministic", () => {
		const key = Buffer.from("0e329232ea6d0d73", "hex");
		const data = Buffer.from("8787878787878787", "hex");
		expect(hex(desEncryptBlock(key, data))).toBe(
			hex(desEncryptBlock(key, data)),
		);
	});
});
