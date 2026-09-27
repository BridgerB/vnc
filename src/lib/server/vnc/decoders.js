/**
 * Pixel decoders. Each produces an RGBA buffer (alpha forced to 255) for a
 * rectangle, given the negotiated pixel format of 32bpp / depth 24 with byte
 * order R,G,B,X (red-shift 0, green-shift 8, blue-shift 16, little-endian).
 *
 * With that format a wire pixel is 4 bytes [R,G,B,X] and a ZRLE "CPIXEL" is the
 * 3 significant bytes [R,G,B] (the top byte is always zero at depth 24).
 */

/**
 * Write one RGBA pixel into `out` (width `W`) at (x,y).
 * @param {Uint8Array | Buffer} out @param {number} W @param {number} x @param {number} y
 * @param {number} r @param {number} g @param {number} b
 */
function setPixel(out, W, x, y, r, g, b) {
	const off = (y * W + x) * 4;
	out[off] = r;
	out[off + 1] = g;
	out[off + 2] = b;
	out[off + 3] = 255;
}

/** Decode a Raw rectangle (already RGBX on the wire) to RGBA. @param {Buffer} src @param {number} w @param {number} h */
export function decodeRaw(src, w, h) {
	const out = Buffer.from(src.subarray(0, w * h * 4));
	for (let i = 3; i < out.length; i += 4) out[i] = 255;
	return out;
}

/**
 * Decode a ZRLE rectangle from its already-decompressed byte stream.
 * @param {Buffer} data decompressed tile stream
 * @param {number} W rectangle width
 * @param {number} H rectangle height
 * @returns {Buffer} RGBA pixels, W*H*4 bytes
 */
export function decodeZrle(data, W, H) {
	const out = Buffer.alloc(W * H * 4);
	let p = 0;

	const readCPixel = () => {
		const r = data[p],
			g = data[p + 1],
			b = data[p + 2];
		p += 3;
		return [r, g, b];
	};
	const readRunLength = () => {
		let run = 1;
		let b;
		do {
			b = data[p++];
			run += b;
		} while (b === 0xff);
		return run;
	};

	for (let ty = 0; ty < H; ty += 64) {
		const th = Math.min(64, H - ty);
		for (let tx = 0; tx < W; tx += 64) {
			const tw = Math.min(64, W - tx);
			const nPix = tw * th;
			const sub = data[p++];

			if (sub === 0) {
				// Raw tile.
				for (let j = 0; j < th; j++)
					for (let i = 0; i < tw; i++) {
						const [r, g, b] = readCPixel();
						setPixel(out, W, tx + i, ty + j, r, g, b);
					}
			} else if (sub === 1) {
				// Solid tile.
				const [r, g, b] = readCPixel();
				for (let j = 0; j < th; j++)
					for (let i = 0; i < tw; i++)
						setPixel(out, W, tx + i, ty + j, r, g, b);
			} else if (sub >= 2 && sub <= 16) {
				// Packed palette.
				const palSize = sub;
				const pal = [];
				for (let k = 0; k < palSize; k++) pal.push(readCPixel());
				const bpp = palSize <= 2 ? 1 : palSize <= 4 ? 2 : 4;
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
						const idx = (cur >> bits) & mask;
						const [r, g, b] = pal[idx];
						setPixel(out, W, tx + i, ty + j, r, g, b);
					}
					// Each row is padded to a byte boundary (leftover bits dropped).
				}
			} else if (sub === 128) {
				// Plain RLE.
				let ti = 0;
				while (ti < nPix) {
					const [r, g, b] = readCPixel();
					let run = readRunLength();
					while (run-- > 0 && ti < nPix) {
						setPixel(out, W, tx + (ti % tw), ty + ((ti / tw) | 0), r, g, b);
						ti++;
					}
				}
			} else if (sub >= 130) {
				// Palette RLE.
				const palSize = sub - 128;
				const pal = [];
				for (let k = 0; k < palSize; k++) pal.push(readCPixel());
				let ti = 0;
				while (ti < nPix) {
					let idx = data[p++];
					if (idx < 128) {
						const [r, g, b] = pal[idx];
						setPixel(out, W, tx + (ti % tw), ty + ((ti / tw) | 0), r, g, b);
						ti++;
					} else {
						idx -= 128;
						const [r, g, b] = pal[idx];
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
}

/**
 * Decode a Cursor pseudo-encoding body into an RGBA cursor image.
 * @param {Buffer} body pixels (w*h*4) followed by a 1bpp mask
 * @param {number} w @param {number} h
 */
export function decodeCursor(body, w, h) {
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
			out[pi + 3] = opaque ? 255 : 0;
		}
	}
	return out;
}
