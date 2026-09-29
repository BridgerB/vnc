/**
 * In-process virtual input device via Linux uinput — no Python, no separate
 * helper process. Device creation needs ioctl (which Node has no built-in for),
 * so koffi (a prebuilt FFI) is used for that one libc call; the fd comes from
 * node:fs and every input event is a 24-byte struct written with fs.writeSync.
 *
 * Kernel-level injection: works in games and held keys stay held. Requires write
 * access to /dev/uinput (add the user to the `input` group or a udev rule), and
 * on NixOS the koffi prebuilt loads via nix-ld.
 */

import fs from "node:fs";
import koffi from "koffi";

// ---- ioctl request codes (asm-generic _IOC encoding) ----
const IOC_WRITE = 1;
const ioc = (dir: number, type: number, nr: number, size: number) =>
	((dir << 30) | (size << 16) | (type << 8) | nr) >>> 0;
const io = (type: number, nr: number) => ioc(0, type, nr, 0);
const iow = (type: number, nr: number, size: number) =>
	ioc(IOC_WRITE, type, nr, size);

const UINPUT_IOCTL_BASE = 0x55; // 'U'
const UI_DEV_CREATE = io(UINPUT_IOCTL_BASE, 1);
const UI_DEV_DESTROY = io(UINPUT_IOCTL_BASE, 2);
const UI_SET_EVBIT = iow(UINPUT_IOCTL_BASE, 100, 4);
const UI_SET_KEYBIT = iow(UINPUT_IOCTL_BASE, 101, 4);
const UI_SET_RELBIT = iow(UINPUT_IOCTL_BASE, 102, 4);
const UI_SET_ABSBIT = iow(UINPUT_IOCTL_BASE, 103, 4);

// ---- event types / codes (linux/input-event-codes.h) ----
const EV_SYN = 0;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const SYN_REPORT = 0;
const ABS_X = 0;
const ABS_Y = 1;
const REL_X = 0;
const REL_Y = 1;
const REL_HWHEEL = 6;
const REL_WHEEL = 8;
const BTN_LEFT = 0x110;
const BTN_RIGHT = 0x111;
const BTN_MIDDLE = 0x112;

const ABS_MAX = 65535; // absolute range is normalised 0..65535 (resolution-independent)
const KEY_MAX = 248; // set key bits 1..248 like the previous evdev helper
const ABS_CNT = 64;
const UINPUT_MAX_NAME_SIZE = 80;
const EVENT_SIZE = 24; // struct input_event on 64-bit: 16 (timeval) + 2 + 2 + 4
const ABS_ARRAY_OFF = UINPUT_MAX_NAME_SIZE + 8 + 4; // after name + input_id + ff_effects_max

/** The imperative surface index.ts drives. */
export interface Uinput {
	moveAbs(x: number, y: number): void;
	moveRel(dx: number, dy: number): void;
	button(btn: number, down: boolean): void; // btn 0=left 1=right 2=middle
	wheel(v: number): void;
	hwheel(v: number): void;
	key(code: number, down: boolean): void;
	destroy(): void;
}

/** Build the legacy `struct uinput_user_dev` used to create the device. */
const buildUserDev = (name: string): Buffer => {
	const buf = Buffer.alloc(ABS_ARRAY_OFF + ABS_CNT * 4 * 4);
	buf.write(name.slice(0, UINPUT_MAX_NAME_SIZE - 1), 0, "utf8");
	buf.writeUInt16LE(0x03, UINPUT_MAX_NAME_SIZE); // input_id.bustype = BUS_USB
	// absmax[] is the first of the four abs arrays; only X/Y need a range.
	buf.writeInt32LE(ABS_MAX, ABS_ARRAY_OFF + ABS_X * 4);
	buf.writeInt32LE(ABS_MAX, ABS_ARRAY_OFF + ABS_Y * 4);
	return buf;
};

const btnCode = (btn: number) =>
	btn === 1 ? BTN_RIGHT : btn === 2 ? BTN_MIDDLE : BTN_LEFT;

/** Create the virtual device and return handles to inject events. */
export const createUinput = (name = "vnc-virtual-input"): Uinput => {
	const libc = koffi.load("libc.so.6");
	const ioctl = libc.func("int ioctl(int fd, unsigned long request, int arg)");
	const fd = fs.openSync(
		"/dev/uinput",
		fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
	);

	const set = (request: number, value: number) => {
		if (ioctl(fd, request, value) < 0)
			throw new Error(`uinput ioctl 0x${request.toString(16)} failed`);
	};
	for (const ev of [EV_SYN, EV_KEY, EV_REL, EV_ABS]) set(UI_SET_EVBIT, ev);
	for (const abs of [ABS_X, ABS_Y]) set(UI_SET_ABSBIT, abs);
	for (const rel of [REL_X, REL_Y, REL_WHEEL, REL_HWHEEL])
		set(UI_SET_RELBIT, rel);
	for (const b of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) set(UI_SET_KEYBIT, b);
	for (let code = 1; code <= KEY_MAX; code++) set(UI_SET_KEYBIT, code);

	fs.writeSync(fd, buildUserDev(name));
	if (ioctl(fd, UI_DEV_CREATE, 0) < 0)
		throw new Error("uinput UI_DEV_CREATE failed");

	const emit = (type: number, code: number, value: number) => {
		const b = Buffer.alloc(EVENT_SIZE);
		b.writeUInt16LE(type, 16);
		b.writeUInt16LE(code, 18);
		b.writeInt32LE(value | 0, 20);
		fs.writeSync(fd, b);
	};
	const syn = () => emit(EV_SYN, SYN_REPORT, 0);

	return {
		moveAbs(x, y) {
			emit(EV_ABS, ABS_X, x);
			emit(EV_ABS, ABS_Y, y);
			syn();
		},
		moveRel(dx, dy) {
			emit(EV_REL, REL_X, dx);
			emit(EV_REL, REL_Y, dy);
			syn();
		},
		button(btn, down) {
			emit(EV_KEY, btnCode(btn), down ? 1 : 0);
			syn();
		},
		wheel(v) {
			emit(EV_REL, REL_WHEEL, v);
			syn();
		},
		hwheel(v) {
			emit(EV_REL, REL_HWHEEL, v);
			syn();
		},
		key(code, down) {
			emit(EV_KEY, code, down ? 1 : 0);
			syn();
		},
		destroy() {
			try {
				ioctl(fd, UI_DEV_DESTROY, 0);
			} catch {
				/* already gone */
			}
			try {
				fs.closeSync(fd);
			} catch {
				/* already closed */
			}
		},
	};
};
