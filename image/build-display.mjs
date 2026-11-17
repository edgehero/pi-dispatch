#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function buildDisplay({ base, tag, bin = "docker", run = spawnSync, pid = process.pid }) {
	if (!base || !tag || !["docker", "podman"].includes(bin) || [base, tag].some((s) => s.startsWith("-") || /\s/.test(s))) throw new Error("Usage: node image/build-display.mjs <local-base-image> <output-tag> [docker|podman]");
	const inspected = run(bin, ["image", "inspect", "--format={{json .}}", base], { encoding: "utf8" });
	if (inspected.status !== 0) throw new Error("The base image must already be present in this runtime's store.");
	const info = JSON.parse(inspected.stdout);
	const id = info.Id;
	if (!/^(sha256:)?[a-f0-9]{64}$/.test(id)) throw new Error("The runtime returned no image ID");
	const inherited = info.Config?.Labels?.["dev.pi-dispatch.capabilities"] ?? "";
	if (!/^[A-Za-z][A-Za-z0-9]*(,[A-Za-z][A-Za-z0-9]*)*$/.test(inherited)) throw new Error("The base must declare the shipped image's capabilities");
	const capabilities = [...new Set([...inherited.split(","), "display"])].join(",");
	// BuildKit interprets FROM sha256:... as a registry name, not a local image ID. An owned temporary tag pins the
	// inspected image while the build runs; it is removed afterwards without removing the operator's reference.
	const pinned = `pi-dispatch-display-base:${id.replace(/^sha256:/, "")}-${pid}`;
	if (run(bin, ["tag", id, pinned]).status !== 0) throw new Error("Could not pin the local base");
	try {
		const built = run(bin, ["build", "--pull=false", "-f", "image/Dockerfile.display", "--build-arg", `BASE=${pinned}`, "--build-arg", `CAPABILITIES=${capabilities}`, "-t", tag, "."], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" });
		return built.status ?? 1;
	} finally {
		if (run(bin, ["image", "rm", pinned], { stdio: "ignore" }).status !== 0) console.error(`Remove the temporary base tag: ${bin} image rm ${pinned}`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [base, tag, bin] = process.argv.slice(2);
	try { process.exitCode = buildDisplay({ base, tag, bin }); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
