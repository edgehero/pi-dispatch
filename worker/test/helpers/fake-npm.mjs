/**
 * An npm that answers the way a service's install asks it: resolve first (`install --package-lock-only`, which writes a lockfile and installs nothing), then `ci`, which installs what the
 * lockfile says. The real npm is what `package-stage-npm.test.mjs` runs; this is for tests about everything around it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const specOf = (spec) => {
	const at = spec.lastIndexOf("@");
	return [spec.slice(0, at), spec.slice(at + 1)];
};

export function fakeNpm({ fail = {}, files = {}, manifest = {}, view = { stdout: '"1.1.0"' }, resolved = null, materialize = null } = {}) {
	const calls = [];
	const exec = async (_bin, args, options) => {
		calls.push({ args, options });
		if (args[0] === "config") return { stdout: JSON.stringify({ registry: "https://registry.npmjs.org/" }) };
		if (args[0] === "view") {
			if (view instanceof Error) throw view;
			return view;
		}
		if (args[0] === "install") {
			const [name, version] = specOf(args[1]);
			if (fail[version]) throw Object.assign(new Error("exit 1"), { stderr: fail[version] });
			const entry = resolved ?? { resolved: `https://registry.npmjs.org/${name}/-/x-${version}.tgz`, integrity: "sha512-abc" };
			writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify({ packages: { "": {}, [`node_modules/${name}`]: { version, ...entry } }, spec: args[1] }));
			return { stdout: "" };
		}
		if (args[0] === "ci") {
			const lockPath = join(options.cwd, "package-lock.json");
			if (!existsSync(lockPath)) throw new Error("ci without a resolved tree");
			const [name, version] = specOf(JSON.parse(readFileSync(lockPath, "utf8")).spec);
			const root = join(options.cwd, "node_modules", name);
			mkdirSync(root, { recursive: true });
			if (materialize) {
				materialize(root, name, version);
				return { stdout: "" };
			}
			writeFileSync(join(root, "package.json"), JSON.stringify({ name, version, pi: { extensions: ["index.js"] }, ...manifest }));
			writeFileSync(join(root, "index.js"), `export default () => {}; // ${version}\n`);
			for (const [file, text] of Object.entries(files)) {
				mkdirSync(join(root, file, ".."), { recursive: true });
				writeFileSync(join(root, file), text);
			}
			return { stdout: "" };
		}
		throw new Error(`fake npm was asked for ${args[0]}`);
	};
	return { exec, calls };
}
