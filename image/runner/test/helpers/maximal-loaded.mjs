import { buildLoaded, LOADED_JOB_TOOLS, LOADED_MAX_COUNT, LOADED_MAX_EXT_TOOLS, LOADED_MAX_OVERLAY_NAMES, LOADED_MAX_PACKAGES, LOADED_MAX_PROBLEM_COUNT, LOADED_MAX_SERVERS, LOADED_MAX_TOOL_COUNT, LOADED_ROW } from "../../src/loaded.mjs";

/** The roots a job's record is measured against, at the mounts layout. */
export const ROOTS = Object.freeze({ packages: [], jobPi: "/job/pi", triggerSkills: "/job/trigger-skills", overlay: "/opt/pi-global", workspace: "/workspace" });

/**
 * Every list at its cap and every name at its longest, with the small counts buildLoaded's own input gives: the largest `full`
 * form a run could write without a count at its bound.
 */
export function longestNames() {
	const packages = Array.from({ length: LOADED_MAX_PACKAGES + 8 }, (_, i) => `/opt/pi-global/packages/p${i}`);
	const roots = { ...ROOTS, packages };
	const name = (prefix, i) => `${prefix}${String(i).padStart(2, "0")}`.padEnd(48, "x");
	const overlayNames = Array.from({ length: LOADED_MAX_OVERLAY_NAMES }, (_, i) => name("o", i));
	const tools = [
		...packages.map((root, i) => ({ name: name("p", i), path: `${root}/ext.js` })),
		...overlayNames.slice(0, LOADED_MAX_EXT_TOOLS - packages.length).map((overlayName, i) => ({ name: name("t", i), path: `/opt/pi-global/extensions/${overlayName}` })),
		...LOADED_JOB_TOOLS.map((jobTool) => ({ name: jobTool, path: "<inline:job-own>" })),
		// `tools.own` keeps a name only when pi's own tool list says `builtin:`, as `buildLoaded` reads it. Without these the
		// worst line had no own tools at all, and every size measured from it was 60 characters short.
		...["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].map((own) => ({ name: own, path: `builtin:${own}` })),
	];
	return buildLoaded({
		at: "session",
		pi: `${"9".repeat(28)}.9.9`,
		roots,
		flow: "deep",
		skills: [{ name: "deep", filePath: `${packages[LOADED_MAX_PACKAGES + 7]}/skills/deep/SKILL.md` }],
		extensions: overlayNames.map((overlayName) => `/opt/pi-global/extensions/${overlayName}`),
		tools,
		active: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", ...LOADED_JOB_TOOLS],
		ownNames: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
		mcp: Array.from({ length: LOADED_MAX_SERVERS }, () => ["connected", LOADED_MAX_TOOL_COUNT]),
		// Every name of the longest list `run.excludeExtensionTools` takes matched nothing (the loader's cap, held to this by exclude-extensions.test.mjs).
		unmatched: Array.from({ length: 16 }, (_, i) => i),
	});
}

/**
 * The largest `loaded` the runner can note, built through buildLoaded and then widened where its input cannot reach
 * cheaply: every row at its clamp, every list at its cap, every name at its longest, each tier total at the largest safe
 * integer (`tiers` keeps true totals, so nothing here bounds it) and each `cut` count at five digits. That is the worst for
 * this LINE's budget; the worker reads a count past 999,999 as `invalid` (`LOADED_COUNT_MAX`), so its own worst RECORD is built
 * from this with those brought in (worker/test/loaded-record.test.mjs `maximal`).
 */
export function maximalLoaded() {
	const loaded = longestNames();
	const row = LOADED_ROW.map((_, slot) => (slot < 5 ? LOADED_MAX_COUNT : LOADED_MAX_PROBLEM_COUNT));
	return {
		...loaded,
		packages: loaded.packages.map(() => [...row]),
		tiers: Object.fromEntries(Object.keys(loaded.tiers).map((tier) => [tier, LOADED_ROW.map(() => Number.MAX_SAFE_INTEGER)])),
		mcp: loaded.mcp,
		tools: { ...loaded.tools, active: LOADED_MAX_TOOL_COUNT },
		cut: { form: "full", packages: 99_999, servers: 99_999, names: 99_999, counts: 99_999 },
	};
}
