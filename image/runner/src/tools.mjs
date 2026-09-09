import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { configError } from "./outcome.mjs";

/**
 * The pinned pi's built-in tool names, DERIVED from the artifact rather than written down (issue #291).
 *
 * pi spells the canonical set once, as `allToolNames` in dist/core/tools/index.js -- and does not export
 * it from the package root, and the exports map is closed, so a bare deep import fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. What the root DOES export is one factory per tool, so the set is read
 * off the factories' own `.name` fields: a derivation, never a restated table, which is the rule a
 * hand-written copy here would break (a pin bump that renames a tool would leave the copy lying).
 * pinned-api.test.mjs pins the two sources against each other so the day pi exports the set publicly
 * this reach-around is retired loudly, not discovered.
 *
 * The factory argument is a cwd; the `.name` on the returned definition is static (verified at the
 * pin), so "/" serves and nothing here touches the filesystem.
 */
let cached;
export function excludableToolNames() {
	cached ??= [
		createReadToolDefinition,
		createBashToolDefinition,
		createEditToolDefinition,
		createWriteToolDefinition,
		createGrepToolDefinition,
		createFindToolDefinition,
		createLsToolDefinition,
	].map((factory) => factory("/").name);
	return cached;
}

/**
 * Refuse any exclusion the pinned pi would silently ignore -- pre-spend, exit 2, never retried.
 *
 * pi consults `excludeTools` only through a Set filter, so an unknown name is a no-op with no error and
 * no diagnostic: the job would run WITH the tool the trigger says to remove and record a clean exit,
 * which is the silent fail-open this field exists to close. The worker's loader makes this branch
 * unreachable for worker-built containers (it validates the same names at load); it exists for skew --
 * a new triggers file against an image whose pinned set moved -- and for hand-run containers, the same
 * belt run.command's command-unregistered check wears. The entry is shown VERBATIM (JSON.stringify)
 * because parseExcludeTools deliberately does not trim: a padded " bash" must be readable as itself.
 */
export function assertExcludeToolsKnown(excludeTools, known = excludableToolNames()) {
	for (const name of excludeTools) {
		if (!known.includes(name)) {
			throw configError(`invalid PI_EXCLUDE_TOOLS: ${JSON.stringify(name)} is not a tool the pinned pi knows (known: ${known.join(", ")}) -- pi ignores unknown names silently, so this would exclude nothing`);
		}
	}
}
