import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import KeysPopover from "./KeysPopover.svelte";

const CTRL = 0xffe3;
const ALT = 0xffe9;

/** Render with capture callbacks (plain closures, not mocks). */
const setup = () => {
	let sent: number[] | null = null;
	let closed = false;
	render(KeysPopover, {
		onsend: (k: number[]) => {
			sent = k;
		},
		onclose: () => {
			closed = true;
		},
	});
	return {
		get sent() {
			return sent;
		},
		get closed() {
			return closed;
		},
	};
};

describe("KeysPopover macros", () => {
	it("sends Ctrl+Alt+Del and closes", async () => {
		const s = setup();
		await page.getByText("Ctrl + Alt + Del").click();
		expect(s.sent).toEqual([CTRL, ALT, 0xffff]);
		expect(s.closed).toBe(true);
	});

	it("sends Alt+Tab", async () => {
		const s = setup();
		await page.getByText("Alt + Tab").click();
		expect(s.sent).toEqual([ALT, 0xff09]);
	});

	it("sends Print Screen", async () => {
		const s = setup();
		await page.getByText("Print Screen").click();
		expect(s.sent).toEqual([0xff61]);
	});
});
