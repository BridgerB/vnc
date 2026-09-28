/**
 * Pixel decoders. Each produces an RGBA buffer (alpha forced to 255) for a
 * rectangle, given the negotiated pixel format of 32bpp / depth 24 with byte
 * order R,G,B,X (red-shift 0, green-shift 8, blue-shift 16, little-endian).
 *
 * With that format a wire pixel is 4 bytes [R,G,B,X] and a ZRLE "CPIXEL" is the
 * 3 significant bytes [R,G,B] (the top byte is always zero at depth 24).
 */

const ALPHA_OPAQUE = 255;
const ALPHA_WORD = 0xff000000; // opaque alpha in the high byte of a little-endian RGBA word
const TILE = 64; // ZRLE tiles are 64x64
const SUB_RAW = 0;
const SUB_SOLID = 1;
const SUB_PACKED_MAX = 16; // subencodings 2..16 are packed palettes of that size
const SUB_PLAIN_RLE = 128;
const SUB_PALETTE_RLE_MIN = 130; // 130.. are palette RLE (palette size = sub - 128)

/** Decode a Raw rectangle (already RGBX on the wire) to RGBA. */
export const decodeRaw = (src: Buffer, w: number, h: number): Buffer => {
	const out = Buffer.from(src.subarray(0, w * h * 4));
	for (let i = 3; i < out.length; i += 4) out[i] = ALPHA_OPAQUE;
	return out;
};

/** Decode a ZRLE rectangle from its already-decompressed byte stream. */
export const decodeZrle = (data: Buffer, W: number, H: number): Buffer => {
	// Write whole RGBA pixels as single 32-bit stores through a Uint32 view — far
	// cheaper than four byte writes. This assumes a little-endian host (byte order
	// R,G,B,A within the word), matching the negotiated pixel format's endianness.
	const out = new Uint8Array(W * H * 4);
	const out32 = new Uint32Array(out.buffer);
	let p = 0;

	// NB: no closures capture `p` — keeping it a plain local lets V8 hold it in a
	// register instead of a heap context object, which dominates this hot loop.
	for (let ty = 0; ty < H; ty += TILE) {
		const th = Math.min(TILE, H - ty);
		for (let tx = 0; tx < W; tx += TILE) {
			const tw = Math.min(TILE, W - tx);
			const nPix = tw * th;
			const rowStep = W - tw; // out32 gap from a tile row's end to the next row
			const sub = data[p++];

			if (sub === SUB_RAW) {
				let idx = ty * W + tx;
				for (let j = 0; j < th; j++) {
					for (let i = 0; i < tw; i++) {
						out32[idx++] =
							data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | ALPHA_WORD;
						p += 3;
					}
					idx += rowStep;
				}
			} else if (sub === SUB_SOLID) {
				const px =
					data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | ALPHA_WORD;
				p += 3;
				let idx = ty * W + tx;
				for (let j = 0; j < th; j++) {
					for (let i = 0; i < tw; i++) out32[idx++] = px;
					idx += rowStep;
				}
			} else if (sub >= 2 && sub <= SUB_PACKED_MAX) {
				const palette = new Uint32Array(sub);
				for (let k = 0; k < sub; k++) {
					palette[k] =
						data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | ALPHA_WORD;
					p += 3;
				}
				const bpp = sub <= 2 ? 1 : sub <= 4 ? 2 : 4;
				const mask = (1 << bpp) - 1;
				let idx = ty * W + tx;
				for (let j = 0; j < th; j++) {
					let cur = 0;
					let bits = 0;
					for (let i = 0; i < tw; i++) {
						if (bits === 0) {
							cur = data[p++];
							bits = 8;
						}
						bits -= bpp;
						out32[idx++] = palette[(cur >> bits) & mask];
					}
					idx += rowStep;
					// Each row is padded to a byte boundary (leftover bits dropped).
				}
			} else if (sub === SUB_PLAIN_RLE) {
				let idx = ty * W + tx;
				let rx = 0;
				let ti = 0;
				while (ti < nPix) {
					const px =
						data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | ALPHA_WORD;
					p += 3;
					let run = 1;
					let b: number;
					do {
						b = data[p++];
						run += b;
					} while (b === 0xff);
					while (run-- > 0 && ti < nPix) {
						out32[idx++] = px;
						ti++;
						if (++rx === tw) {
							rx = 0;
							idx += rowStep;
						}
					}
				}
			} else if (sub >= SUB_PALETTE_RLE_MIN) {
				const palette = new Uint32Array(sub - 128);
				for (let k = 0; k < sub - 128; k++) {
					palette[k] =
						data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | ALPHA_WORD;
					p += 3;
				}
				let idx = ty * W + tx;
				let rx = 0;
				let ti = 0;
				while (ti < nPix) {
					const index = data[p++];
					if (index < 128) {
						out32[idx++] = palette[index];
						ti++;
						if (++rx === tw) {
							rx = 0;
							idx += rowStep;
						}
					} else {
						const px = palette[index - 128];
						let run = 1;
						let b: number;
						do {
							b = data[p++];
							run += b;
						} while (b === 0xff);
						while (run-- > 0 && ti < nPix) {
							out32[idx++] = px;
							ti++;
							if (++rx === tw) {
								rx = 0;
								idx += rowStep;
							}
						}
					}
				}
			} else {
				throw new Error(`ZRLE: unsupported tile subencoding ${sub}`);
			}
		}
	}
	return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
};

/** Decode a Cursor pseudo-encoding body (w*h*4 pixels + a 1bpp mask) into RGBA. */
export const decodeCursor = (body: Buffer, w: number, h: number): Buffer => {
	const out = Buffer.alloc(w * h * 4);
	const maskRowBytes = Math.floor((w + 7) / 8);
	const maskOff = w * h * 4;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const pi = (y * w + x) * 4;
			const maskByte = body[maskOff + y * maskRowBytes + (x >> 3)];
			const opaque = (maskByte >> (7 - (x & 7))) & 1;
			out[pi] = body[pi]; // R
			out[pi + 1] = body[pi + 1]; // G
			out[pi + 2] = body[pi + 2]; // B
			out[pi + 3] = opaque ? ALPHA_OPAQUE : 0;
		}
	}
	return out;
};
