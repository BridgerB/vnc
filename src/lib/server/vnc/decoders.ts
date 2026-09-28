/**
 * Pixel decoders. Each produces an RGBA buffer (alpha forced to 255) for a
 * rectangle, given the negotiated pixel format of 32bpp / depth 24 with byte
 * order R,G,B,X (red-shift 0, green-shift 8, blue-shift 16, little-endian).
 *
 * With that format a wire pixel is 4 bytes [R,G,B,X] and a ZRLE "CPIXEL" is the
 * 3 significant bytes [R,G,B] (the top byte is always zero at depth 24).
 */

type Rgb = [r: number, g: number, b: number];

const ALPHA_OPAQUE = 255;
const TILE = 64; // ZRLE tiles are 64x64
const SUB_RAW = 0;
const SUB_SOLID = 1;
const SUB_PACKED_MAX = 16; // subencodings 2..16 are packed palettes of that size
const SUB_PLAIN_RLE = 128;
const SUB_PALETTE_RLE_MIN = 130; // 130.. are palette RLE (palette size = sub - 128)

/** Write one RGBA pixel into `out` (row stride `W` pixels) at (x, y). */
const setPixel = (
	out: Uint8Array,
	W: number,
	x: number,
	y: number,
	r: number,
	g: number,
	b: number,
) => {
	const off = (y * W + x) * 4;
	out[off] = r;
	out[off + 1] = g;
	out[off + 2] = b;
	out[off + 3] = ALPHA_OPAQUE;
};

/** Decode a Raw rectangle (already RGBX on the wire) to RGBA. */
export const decodeRaw = (src: Buffer, w: number, h: number): Buffer => {
	const out = Buffer.from(src.subarray(0, w * h * 4));
	for (let i = 3; i < out.length; i += 4) out[i] = ALPHA_OPAQUE;
	return out;
};

/** Decode a ZRLE rectangle from its already-decompressed byte stream. */
export const decodeZrle = (data: Buffer, W: number, H: number): Buffer => {
	const out = Buffer.alloc(W * H * 4);
	let p = 0;

	const readCPixel = (): Rgb => {
		const rgb: Rgb = [data[p], data[p + 1], data[p + 2]];
		p += 3;
		return rgb;
	};
	const readRunLength = () => {
		let run = 1;
		let b: number;
		do {
			b = data[p++];
			run += b;
		} while (b === 0xff);
		return run;
	};

	for (let ty = 0; ty < H; ty += TILE) {
		const th = Math.min(TILE, H - ty);
		for (let tx = 0; tx < W; tx += TILE) {
			const tw = Math.min(TILE, W - tx);
			const nPix = tw * th;
			const sub = data[p++];

			if (sub === SUB_RAW) {
				for (let j = 0; j < th; j++)
					for (let i = 0; i < tw; i++) {
						const [r, g, b] = readCPixel();
						setPixel(out, W, tx + i, ty + j, r, g, b);
					}
			} else if (sub === SUB_SOLID) {
				const [r, g, b] = readCPixel();
				for (let j = 0; j < th; j++)
					for (let i = 0; i < tw; i++)
						setPixel(out, W, tx + i, ty + j, r, g, b);
			} else if (sub >= 2 && sub <= SUB_PACKED_MAX) {
				const palette: Rgb[] = [];
				for (let k = 0; k < sub; k++) palette.push(readCPixel());
				const bpp = sub <= 2 ? 1 : sub <= 4 ? 2 : 4;
				const mask = (1 << bpp) - 1;
				for (let j = 0; j < th; j++) {
					let cur = 0;
					let bits = 0;
					for (let i = 0; i < tw; i++) {
						if (bits === 0) {
							cur = data[p++];
							bits = 8;
						}
						bits -= bpp;
						const [r, g, b] = palette[(cur >> bits) & mask];
						setPixel(out, W, tx + i, ty + j, r, g, b);
					}
					// Each row is padded to a byte boundary (leftover bits dropped).
				}
			} else if (sub === SUB_PLAIN_RLE) {
				let ti = 0;
				while (ti < nPix) {
					const [r, g, b] = readCPixel();
					let run = readRunLength();
					while (run-- > 0 && ti < nPix) {
						setPixel(out, W, tx + (ti % tw), ty + ((ti / tw) | 0), r, g, b);
						ti++;
					}
				}
			} else if (sub >= SUB_PALETTE_RLE_MIN) {
				const palette: Rgb[] = [];
				for (let k = 0; k < sub - 128; k++) palette.push(readCPixel());
				let ti = 0;
				while (ti < nPix) {
					let idx = data[p++];
					if (idx < 128) {
						const [r, g, b] = palette[idx];
						setPixel(out, W, tx + (ti % tw), ty + ((ti / tw) | 0), r, g, b);
						ti++;
					} else {
						idx -= 128;
						const [r, g, b] = palette[idx];
						let run = readRunLength();
						while (run-- > 0 && ti < nPix) {
							setPixel(out, W, tx + (ti % tw), ty + ((ti / tw) | 0), r, g, b);
							ti++;
						}
					}
				}
			} else {
				throw new Error(`ZRLE: unsupported tile subencoding ${sub}`);
			}
		}
	}
	return out;
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
