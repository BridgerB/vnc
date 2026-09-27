/**
 * Map a browser KeyboardEvent to an X11 keysym for the RFB KeyEvent message.
 * Covers printable characters (via event.key) plus the common non-printable keys.
 */

/** @type {Record<string, number>} */
const NAMED = {
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

/** @param {KeyboardEvent} e @returns {number} keysym, or 0 if unmappable */
export function keysymFromEvent(e) {
	const k = e.key;

	// Function keys F1..F24 → 0xffbe..
	if (/^F([1-9]|1\d|2[0-4])$/.test(k)) {
		return 0xffbe + (parseInt(k.slice(1), 10) - 1);
	}

	if (k in NAMED) return NAMED[k];

	// Single printable character: its Unicode code point is the keysym for
	// Latin-1; higher code points use the 0x01000000 + codepoint convention.
	if (k.length === 1) {
		const cp = k.codePointAt(0) ?? 0;
		if (cp <= 0xff) return cp;
		return 0x01000000 + cp;
	}

	return 0;
}
