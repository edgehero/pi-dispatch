import { buildLoaded, LOADED_MAX_COUNT, LOADED_MAX_EXT_TOOLS, LOADED_MAX_OVERLAY_NAMES, LOADED_MAX_PACKAGES, LOADED_MAX_PROBLEM_COUNT, LOADED_MAX_SERVERS, LOADED_MAX_TOOL_COUNT, LOADED_ROW } from "../../src/loaded.mjs";

/** The roots a job's record is measured against, at the mounts layout. */
export const ROOTS = Object.freeze({ packages: [], jobPi: "/job/pi", triggerSkills: "/job/trigger-skills", overlay: "/opt/pi-global", workspace: "/workspace" });

/**
 * The largest `loaded` the runner can note, built through buildLoaded and then widened where its input cannot reach
 * cheaply: every row at its clamp, every list at its cap, every name at its longest, each tier total at the largest safe
 * integer (`tiers` keeps true totals, so nothing else bounds it) and each `cut` count at five digits.
 */
export function maximalLoaded() {
	const packages = Array.from({ length: LOADED_MAX_PACKAGES + 8 }, (_, i) => `/opt/pi-global/packages/p${i}`);
	const roots = { ...ROOTS, packages };
	const name = (prefix, i) => `${prefix}${String(i).padStart(2, "0")}`.padEnd(48, "x");
	const overlayNames = Array.from({ length: LOADED_MAX_OVERLAY_NAMES }, (_, i) => name("o", i));
	const tools = [
		...packages.map((root, i) => ({ name: name("p", i), path: `${root}/ext.js` })),
		...overlayNames.slice(0, LOADED_MAX_EXT_TOOLS - packages.length).map((overlayName, i) => ({ name: name("t", i), path: `/opt/pi-global/extensions/${overlayName}` })),
	];
	const loaded = buildLoaded({
		at: "session",
		pi: "9".repeat(32),
		roots,
		flow: "deep",
		skills: [{ name: "deep", filePath: `${packages[LOADED_MAX_PACKAGES + 7]}/skills/deep/SKILL.md` }],
		extensions: overlayNames.map((overlayName) => `/opt/pi-global/extensions/${overlayName}`),
		tools,
		active: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
		ownNames: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
		mcp: Array.from({ length: LOADED_MAX_SERVERS }, () => ["connected", LOADED_MAX_TOOL_COUNT]),
	});
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
