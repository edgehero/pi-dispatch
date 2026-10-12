/**
 * The MCP canary's resolve hook (REQ-MCP-OPERATOR-SERVERS). Loaded with `node --import`, it sends every
 * `@earendil-works/*` import, and every import made from inside such a package, to the copy of pi installed in
 * MCP_CANARY_PI (a scratch directory holding pi@latest), and leaves every other specifier to the repository. So the
 * runner's own MCP tests (image/runner/test/mcp.test.mjs and pinned-api.test.mjs's MCP block) run unchanged against the
 * newest pi, and a release that changes what image/runner/src/mcp.mjs rests on (the MCP extension's events, its
 * options, the transports, the connect order) shows up here before the daily bump pull request does.
 *
 * Why a hook rather than a copy of the runner: the tests import worker modules beside the runner's, whose own
 * dependencies live in the repository's install. Redirecting one scope keeps everything else exactly as CI runs
 * it. `import.meta.resolve` goes through the same hook, so the pinned tests that read pi's dist files read the
 * scratch copy.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const scratch = process.env.MCP_CANARY_PI;
if (typeof scratch !== "string" || scratch === "") throw new Error("MCP_CANARY_PI names no scratch directory holding pi@latest");

register(
	"data:text/javascript," +
		encodeURIComponent(`
			const base = ${JSON.stringify(pathToFileURL(`${scratch}/`).href)};
			export async function resolve(specifier, context, next) {
				if (specifier.startsWith("@earendil-works/") && !(context.parentURL ?? "").startsWith(base)) {
					return next(specifier, { ...context, parentURL: base + "index.mjs" });
				}
				return next(specifier, context);
			}
		`),
	import.meta.url,
);
