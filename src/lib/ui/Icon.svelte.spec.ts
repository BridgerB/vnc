import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import Icon from "./Icon.svelte";

describe("Icon", () => {
	it("references the named sprite symbol", () => {
		render(Icon, { name: "full" });
		expect(document.querySelector("use")?.getAttribute("href")).toBe("#r-full");
	});

	it("applies the given size", () => {
		render(Icon, { name: "key", size: 24 });
		expect(document.querySelector("svg")?.getAttribute("width")).toBe("24");
	});

	it("passes through a class", () => {
		render(Icon, { name: "cog", class: "accent" });
		expect(document.querySelector("svg")?.getAttribute("class")).toContain(
			"accent",
		);
	});
});
