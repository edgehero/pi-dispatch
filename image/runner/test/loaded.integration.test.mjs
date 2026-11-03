import assert from "node:assert/strict";
import { test } from "node:test";
import { chatServer, jobTree, piTheme, put, runRealJob } from "./helpers/real-job.mjs";

/**
 * Issue #800, end to end: the real run-job.mjs with the real pi, its mounts moved under a temp directory
 * (helpers/real-job.mjs). A pure test can say what buildLoaded does with what it is handed; only this says what pi
 * really hands it, and whether the line a real job ends on holds what it claims.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`what a job loaded is REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

test("packages_loaded counts a package's theme (Theme.sourcePath: under filePath, which pi's Theme does not have, it read 0)", { skip }, async () => {
	const server = await chatServer();
	try {
		const root = jobTree({ base: server.base });
		put(root, "/opt/pi-global/packages/tints/package.json", JSON.stringify({ name: "tints", version: "1.0.0", pi: { themes: ["themes/tint.json"], prompts: ["prompts/hello.md"] } }));
		put(root, "/opt/pi-global/packages/tints/themes/tint.json", piTheme("tint"));
		put(root, "/opt/pi-global/packages/tints/prompts/hello.md", "---\ndescription: hello\n---\nhello\n");
		const { exit, lines, stderr } = await runRealJob(root, { PI_PACKAGES: "/opt/pi-global/packages/tints" });
		assert.equal(exit?.code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		const counted = lines.find((line) => line.event === "packages_loaded");
		assert.deepEqual(counted.packages, [{ root: "/opt/pi-global/packages/tints", extensions: 0, skills: 0, prompts: 1, themes: 1 }], "a theme the package ships is one theme");
	} finally {
		await server.close();
	}
});
