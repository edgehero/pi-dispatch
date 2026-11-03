/** Self-hosted browser assets. Build output is disposable; source mode can ask for these same bytes in memory. */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GATEWAY_CSS } from "./src/style.mjs";
import { NODE_REQUIRE_PRELUDE } from "../admin/bundle-options.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runtimeDependencies = Object.keys(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies ?? {});

export async function buildGatewayAssets({ write = false, outdir = join(here, "dist/static") } = {}) {
	// The public bootstrap retains the console's syntax floor and explains missing browser capabilities.
	// xterm itself supports current browsers; lowering its published artifact to Safari 14 is unsupported.
	const bundle = (entry, format, target) => build({ entryPoints: [join(here, "src", entry)], bundle: true, write: false, format, platform: "browser", target, external: ["/static/terminal.js"], legalComments: "inline", logLevel: "silent" });
	const [bootstrap, terminal] = await Promise.all([bundle("bootstrap.mjs", "iife", ["chrome88", "safari14", "firefox78"]), bundle("terminal-entry.mjs", "esm", ["chrome100", "safari16.4", "firefox100"])]);
	const assets = { script: bootstrap.outputFiles[0].text, terminalScript: terminal.outputFiles[0].text, css: `${GATEWAY_CSS}\n${readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8")}\n${readFileSync(require.resolve("dockview/dist/styles/dockview.css"), "utf8")}` };
	if (write) {
		mkdirSync(outdir, { recursive: true });
		for (const [name, text] of [["gateway.js", assets.script], ["terminal.js", assets.terminalScript], ["gateway.css", assets.css]]) writeFileSync(join(outdir, name), text);
		// esbuild preserves the source entry's shebang before this banner.
		await build({ entryPoints: [join(here, "src/cli.mjs")], outfile: join(outdir, "../cli.mjs"), bundle: true, format: "esm", platform: "node", target: "node22", external: runtimeDependencies, banner: { js: `// pi-dispatch sandbox gateway (bundled).\n${NODE_REQUIRE_PRELUDE}` }, logLevel: "silent" });
	}
	return assets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await buildGatewayAssets({ write: true });
	console.log("Built gateway browser assets.");
}
