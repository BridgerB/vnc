/**
 * Map a browser KeyboardEvent to an X11 keysym for the RFB KeyEvent message.
 * Covers printable characters (via event.key) plus the common non-printable keys.
 */

const NAMED: Record<string, number> = {
	Backspace: 0xff08,
	Tab: 0xff09,
	Enter: 0xff0d,
	Escape: 0xff1b,
	Delete: 0xffff,
	Home: 0xff50,
	End: 0xff57,
	PageUp: 0xff55,
	PageDown: 0xff56,
	ArrowLeft: 0xff51,
	ArrowUp: 0xff52,
	ArrowRight: 0xff53,
	ArrowDown: 0xff54,
	Insert: 0xff63,
	Shift: 0xffe1,
	Control: 0xffe3,
	Alt: 0xffe9,
	Meta: 0xffe7, // left Super/Command
	CapsLock: 0xffe5,
	ContextMenu: 0xff67,
	Pause: 0xff13,
	PrintScreen: 0xff61,
	NumLock: 0xff7f,
	ScrollLock: 0xff14,
	" ": 0x0020,
};

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;
const KEYSYM_F1 = 0xffbe;
const KEYSYM_UNICODE_BASE = 0x01000000;

/** The X11 keysym for a KeyboardEvent, or 0 when it can't be mapped. */
export const keysymFromEvent = (e: KeyboardEvent): number => {
	const k = e.key;

	// Function keys F1..F24 -> 0xffbe..
	if (FUNCTION_KEY.test(k))
		return KEYSYM_F1 + (Number.parseInt(k.slice(1), 10) - 1);

	const named = NAMED[k];
	if (named !== undefined) return named;

	// A single printable character: its Unicode code point is the keysym for
	// Latin-1; higher code points use the 0x01000000 + codepoint convention.
	if (k.length === 1) {
		const cp = k.codePointAt(0) ?? 0;
		return cp <= 0xff ? cp : KEYSYM_UNICODE_BASE + cp;
	}

	return 0;
};
