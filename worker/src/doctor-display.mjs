import { DISPLAY_CAPABILITY } from "./display-probe.mjs";

/** Each image is checked in the store its jobs use. A capability is not a backend isolation declaration. */
export function displayTargets({ image, venues, routes = [] }) {
	const found = new Map();
	for (const row of [...venues.map((venue) => ({ image, backend: venue })), ...routes]) {
		const venue = row.backend ?? venues[0];
		if (typeof row.image === "string" && venues.includes(venue)) found.set(`${venue}\0${row.image}`, { image: row.image, venue });
	}
	return [...found.values()];
}

export async function checkDisplays({ targets, size, inspect, prepare, probe }) {
	const checks = [];
	for (const target of targets) {
		const prefix = `display on ${target.venue}: ${target.image} (${size.memMiB} MiB, CPU size ${size.cpuCenti / 100})`;
		const image = await inspect(target);
		if (!image?.ok) {
			checks.push({ ok: false, warn: true, label: `${prefix}: not checked (image-unreadable)`, fix: "make the image readable in this venue's store, then re-run doctor --live" });
			continue;
		}
		if (!image.capabilities.includes(DISPLAY_CAPABILITY)) continue;
		const ready = await prepare(target, image);
		const result = ready.run === false ? { ok: false, warn: true, reason: ready.reason, notes: [] } : await probe(target, image, ready);
		checks.push({ ok: result.ok, ...(result.warn ? { warn: true } : {}), label: `${prefix}: ${result.ok ? "headed Chromium rendered text and the clicked page; PNG verified" : result.reason}`, ...(!result.ok ? { fix: "see docs/job-image.md#graphical-applications for the recipe and named display failures; this check does not change the image or job isolation" } : {}) });
		for (const note of result.notes ?? []) checks.push({ ok: false, warn: true, label: `${prefix}: ${note}`, fix: "check the display probe's cleanup before running it again" });
	}
	return checks;
}
