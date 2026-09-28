import { describe, expect, it } from "vitest";
import { decodeCursor, decodeRaw, decodeZrle } from "./decoders.ts";

/** Read the RGBA tuple at (x, y) from a decoded buffer of row width W. */
const px = (out: Buffer, W: number, x: number, y: number): number[] => {
	const o = (y * W + x) * 4;
	return [out[o], out[o + 1], out[o + 2], out[o + 3]];
};

describe("decodeRaw", () => {
	it("forces alpha to 255 on a single pixel", () => {
		const out = decodeRaw(Buffer.from([10, 20, 30, 7]), 1, 1);
		expect([...out]).toEqual([10, 20, 30, 255]);
	});

	it("decodes a 2x1 row", () => {
		const out = decodeRaw(Buffer.from([1, 2, 3, 0, 4, 5, 6, 0]), 2, 1);
		expect([...out]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
	});

	it("reads only w*h*4 bytes even if the source is longer", () => {
		const src = Buffer.from([1, 2, 3, 0, 9, 9, 9, 9]);
		const out = decodeRaw(src, 1, 1);
		expect(out.length).toBe(4);
		expect([...out]).toEqual([1, 2, 3, 255]);
	});
});

describe("decodeCursor", () => {
	it("marks a masked-in pixel opaque", () => {
		// 1x1: pixel + one mask byte with the top bit set.
		const out = decodeCursor(Buffer.from([40, 50, 60, 0, 0x80]), 1, 1);
		expect([...out]).toEqual([40, 50, 60, 255]);
	});

	it("marks a masked-out pixel transparent but keeps its colour", () => {
		const out = decodeCursor(Buffer.from([40, 50, 60, 0, 0x00]), 1, 1);
		expect([...out]).toEqual([40, 50, 60, 0]);
	});

	it("applies the mask per pixel across a row", () => {
		// 2x1: pixel0 opaque (bit7), pixel1 transparent (bit6=0) -> mask 0x80.
		const body = Buffer.from([1, 2, 3, 0, 4, 5, 6, 0, 0x80]);
		const out = decodeCursor(body, 2, 1);
		expect(px(out, 2, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(px(out, 2, 1, 0)).toEqual([4, 5, 6, 0]);
	});
});

describe("decodeZrle", () => {
	it("decodes a solid tile", () => {
		const out = decodeZrle(Buffer.from([1, 100, 150, 200]), 2, 2);
		for (const [x, y] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
		])
			expect(px(out, 2, x, y)).toEqual([100, 150, 200, 255]);
	});

	it("decodes a raw tile in row-major order", () => {
		// sub 0, then 4 CPIXELs: (0,0)(1,0)(0,1)(1,1)
		const data = Buffer.from([0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
		const out = decodeZrle(data, 2, 2);
		expect(px(out, 2, 0, 0)).toEqual([1, 1, 1, 255]);
		expect(px(out, 2, 1, 0)).toEqual([2, 2, 2, 255]);
		expect(px(out, 2, 0, 1)).toEqual([3, 3, 3, 255]);
		expect(px(out, 2, 1, 1)).toEqual([4, 4, 4, 255]);
	});

	it("decodes a packed-palette tile (2 colours, 1bpp)", () => {
		// palette [black, white]; row0 indices [0,1]=0x40, row1 [1,0]=0x80
		const data = Buffer.from([2, 0, 0, 0, 255, 255, 255, 0x40, 0x80]);
		const out = decodeZrle(data, 2, 2);
		expect(px(out, 2, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(px(out, 2, 1, 0)).toEqual([255, 255, 255, 255]);
		expect(px(out, 2, 0, 1)).toEqual([255, 255, 255, 255]);
		expect(px(out, 2, 1, 1)).toEqual([0, 0, 0, 255]);
	});

	it("decodes a plain-RLE tile", () => {
		// sub 128, colour, run byte 3 -> run length 4 fills the 2x2 tile
		const out = decodeZrle(Buffer.from([128, 50, 60, 70, 3]), 2, 2);
		for (const [x, y] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
		])
			expect(px(out, 2, x, y)).toEqual([50, 60, 70, 255]);
	});

	it("decodes a palette-RLE tile with a run", () => {
		// sub 130, palette [black, white], index 129 = run of palette[1], run len 4
		const data = Buffer.from([130, 0, 0, 0, 255, 255, 255, 129, 3]);
		const out = decodeZrle(data, 2, 2);
		for (const [x, y] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
		])
			expect(px(out, 2, x, y)).toEqual([255, 255, 255, 255]);
	});

	it("decodes palette-RLE mixing singles and a run", () => {
		// black single, white single, then run of 2 white (idx 129, run byte 1)
		const data = Buffer.from([130, 0, 0, 0, 255, 255, 255, 0, 1, 129, 1]);
		const out = decodeZrle(data, 2, 2);
		expect(px(out, 2, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(px(out, 2, 1, 0)).toEqual([255, 255, 255, 255]);
		expect(px(out, 2, 0, 1)).toEqual([255, 255, 255, 255]);
		expect(px(out, 2, 1, 1)).toEqual([255, 255, 255, 255]);
	});

	it("handles a run length that spans a 0xff continuation byte", () => {
		// 64x5 tile = 320 px; plain RLE run 320 = 1 + 255 + 64
		const data = Buffer.from([128, 9, 8, 7, 0xff, 64]);
		const out = decodeZrle(data, 64, 5);
		expect(out.length).toBe(64 * 5 * 4);
		expect(px(out, 64, 0, 0)).toEqual([9, 8, 7, 255]);
		expect(px(out, 64, 63, 4)).toEqual([9, 8, 7, 255]);
	});

	it("throws on an unsupported subencoding", () => {
		expect(() => decodeZrle(Buffer.from([17]), 2, 2)).toThrow();
		expect(() => decodeZrle(Buffer.from([129]), 2, 2)).toThrow();
	});
});
