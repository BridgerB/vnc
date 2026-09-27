import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import type { Profile } from "$lib/types";
import MachineCard from "./MachineCard.svelte";

const profile: Profile = {
	id: "m1",
	name: "Workstation",
	host: "10.0.0.4",
	port: 5900,
};
const noop = () => {};

describe("MachineCard", () => {
	it("shows the machine name and defaults to offline", async () => {
		render(MachineCard, {
			p: profile,
			onopen: noop,
			ondelete: noop,
			onedit: noop,
		});
		await expect.element(page.getByText("Workstation")).toBeVisible();
		await expect.element(page.getByText("Offline")).toBeVisible();
	});

	it("reflects an online status", async () => {
		render(MachineCard, {
			p: profile,
			status: "online",
			onopen: noop,
			ondelete: noop,
			onedit: noop,
		});
		await expect.element(page.getByText("Online")).toBeVisible();
	});
});
