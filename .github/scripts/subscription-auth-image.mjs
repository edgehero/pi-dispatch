/** Normal-entrypoint, zero-network conformance for every supported subscription binding (#781). */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { prepareCommunityAuthAdapter } from "../../worker/src/community-auth-patches.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const stagedRoot = "/opt/pi-global/packages/auth";
const profiles = [
	{ provider: "openai", adapter: "openai-chatgpt", model: "gpt-4.1" },
	{ provider: "anthropic", adapter: "pi-anthropic-oauth@0.3.6", model: "claude-sonnet-4-5-20250929", artifact: "pi-anthropic-oauth-0.3.6.tar.gz" },
	{ provider: "anthropic", adapter: "@gotgenes/pi-anthropic-auth@3.4.3", model: "claude-sonnet-4-5-20250929", artifact: "gotgenes-pi-anthropic-auth-3.4.3.tar.gz" },
];

function packageRoot(entry) {
	let path = dirname(entry);
	while (!existsSync(join(path, "package.json"))) {
		const parent = dirname(path);
		if (parent === path) throw new Error("subscription smoke dependency is missing");
		path = parent;
	}
	return path;
}

// Materialize npm ci's exact resolved closure, without symlinks or a second package installation.
function copyClosure(source, destination, ancestors = new Set()) {
	assert.ok(!ancestors.has(source), "subscription smoke dependency cycle requires review");
	const next = new Set(ancestors).add(source);
	cpSync(source, destination, { recursive: true, filter: path => path === source || !path.slice(source.length + 1).split("/").includes("node_modules") });
	const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	const local = createRequire(join(source, "package.json"));
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		const dependency = local.resolve.paths(name).map(path => join(path, name)).find(path => existsSync(join(path, "package.json")));
		assert.ok(dependency, "subscription smoke dependency must already be installed by npm ci");
		copyClosure(dependency, join(destination, "node_modules", name), next);
	}
}

function readable(path) {
	const stat = lstatSync(path);
	assert.ok(!stat.isSymbolicLink(), "subscription smoke staging cannot contain links");
	chmodSync(path, stat.isDirectory() ? 0o755 : 0o644);
	if (stat.isDirectory()) for (const name of readdirSync(path)) readable(join(path, name));
}

const offlineFetch = `
// This replaces every fetch before application imports. Even a malformed route never reaches the network.
let calls = 0;
globalThis.fetch = async (input, init) => {
  calls++;
  const request = new Request(input, init);
  const url = new URL(request.url);
  const provider = process.env.PI_PROVIDER;
  const expectedUrl = provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages";
  const credential = process.env[provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_OAUTH_TOKEN"];
  const authOk = request.headers.get("authorization") === "Bearer " + credential && !request.headers.has("x-api-key") && !request.headers.has("api-key");
  const urlOk = url.origin + url.pathname === expectedUrl;
  let modelOk = false;
  try { modelOk = JSON.parse(await request.text()).model === process.env.PI_MODEL; } catch {}
  console.log(JSON.stringify({event:"subscription_smoke_fetch",calls,provider,authOk,urlOk,modelOk}));
  if (process.env.PI_AUTH_SMOKE_MODE !== "provider") throw new Error("subscription smoke unexpected dispatch");
  return new Response(JSON.stringify({error:provider === "openai" ? {code:"usage_limit_reached",type:"usage_limit_reached",message:"synthetic quota refusal"} : {type:"rate_limit_error",message:"synthetic throttle"}}), {status:429,headers:{"content-type":"application/json","retry-after":"600"}});
};
`;

/** The verdict requires a signed decisive line and the real request path, never just matching log text. */
export function subscriptionSmokeProblems({ output, status, key, provider, mode }) {
	const problems = [];
	const events = output.split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line); return row !== null && typeof row === "object" && !Array.isArray(row) ? [row] : []; } catch { return []; } });
	const exits = events.filter(row => row.event === "exit");
	const exit = exits.at(-1);
	if (exits.length !== 1 || !exit) return ["expected one decisive exit line"];
	const signed = output.split(/\r?\n/).findLast(line => { try { return JSON.parse(line).event === "exit"; } catch { return false; } });
	const body = signed.replace(/,"auth":"[a-f0-9]{64}"\}$/, "}");
	if (body === signed || createHmac("sha256", key).update(body).digest("hex") !== exit.auth) problems.push("exit evidence is not authenticated");
	if (exit.tokens?.modelRefused !== 0) problems.push("model admission did not pass");
	if (events.some(row => row.event === "extension_load_error" || row.event === "extension_error")) problems.push("extension failed to load");
	const requests = events.filter(row => row.event === "subscription_smoke_fetch");
	if (mode === "cost") {
		if (status !== 2 || exit.code !== 2 || exit.reason !== "cost-cap" || exit.tokens?.costRefused !== 1) problems.push("normal runner did not refuse its first call at the initial cost bound");
		if (requests.length !== 0) problems.push("a cost-refused job attempted dispatch");
	} else {
		if (status !== 1 || exit.code !== 1 || !["quota-exhausted", "rate-limited"].includes(exit.providerFailure?.kind) || exit.providerFailure?.subscriptionProvider !== provider) problems.push("synthetic throttle did not retain typed subscription evidence");
		if (provider === "openai" && exit.providerFailure?.subscriptionCode !== "usage_limit_reached") problems.push("OpenAI typed quota code was lost");
		if (exit.tokens?.costRefused !== 0 || exit.tokens?.calls !== 2 || exit.tokens?.metered !== true || exit.toolsStarted !== false || exit.replaySafe !== true) problems.push("provider observation bypassed ordinary metering or replay evidence");
		const retries = events.filter(row => row.event === "pi_auto_retry");
		if (requests.length !== 2 || requests.some((row, index) => row.calls !== index + 1 || row.provider !== provider || !row.authOk || !row.urlOk || !row.modelOk) || retries.length !== 1 || retries[0].attempt !== 1 || retries[0].maxAttempts !== 1) problems.push("expected the initial request and one bounded retry, both correctly authenticated and shaped, with no refresh call");
	}
	return problems;
}

export function verifySubscriptionImage(image) {
	assert.ok(typeof image === "string" && image.length > 0, "usage: node .github/scripts/subscription-auth-image.mjs IMAGE_REF");
	const scratch = mkdtempSync(join(tmpdir(), "pi-subscription-image-"));
	const containers = new Set();
	try {
		for (const [index, profile] of profiles.entries()) {
			const pinned = getBuiltinModels(profile.provider).find(model => model.id === profile.model);
			assert.equal(pinned?.api, profile.provider === "openai" ? "openai-responses" : "anthropic-messages", "smoke model must be physical at the exact pi pin");
			const directory = join(scratch, String(index));
			const job = join(directory, "job");
			mkdirSync(job, { recursive: true });
			writeFileSync(join(job, "prompt.md"), "Reply with the single word ok.\n");
			writeFileSync(join(job, "offline-fetch.mjs"), offlineFetch);
			let prepared;
			const root = join(directory, "package");
			if (profile.artifact) {
				mkdirSync(root);
				execFileSync("tar", ["-xzf", join(repository, "worker/test/fixtures/community-auth", profile.artifact), "--strip-components=1", "-C", root]);
				if (profile.adapter === "pi-anthropic-oauth@0.3.6") copyClosure(packageRoot(require.resolve("primary-anthropic-sdk")), join(root, "node_modules/@anthropic-ai/sdk"));
				prepared = prepareCommunityAuthAdapter({ adapter: profile.adapter, root });
			}
			readable(scratch);
			for (const mode of ["cost", "provider"]) {
				const name = `pi-subscription-smoke-${process.pid}-${index}-${mode}`;
				containers.add(name);
				const key = randomBytes(32).toString("hex");
				const at = Date.now();
				const binding = { provider: profile.provider, adapter: profile.adapter, connectionId: "smoke", generation: 1, expiresAt: at + 2 * 3_600_000, deadlineAt: at + 1_800_000, ...(prepared ? { root: stagedRoot, digest: prepared.digest } : {}) };
				const env = {
					PI_PROVIDER: profile.provider, PI_MODEL: profile.model, PI_ALLOWED_MODELS: `${profile.provider}/${profile.model}`,
					PI_MAX_COST_MICROS: mode === "cost" ? "1" : "100000000", PI_MAX_TURNS: "1", PI_RETRY_MAX: "1", PI_RETRY_BASE_MS: "1",
					PI_EXIT_AUTH: "stdin", PI_SUBSCRIPTION_AUTH: JSON.stringify([binding]), PI_AUTH_SMOKE_MODE: mode,
					NODE_OPTIONS: "--import=/job/offline-fetch.mjs",
					[profile.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_OAUTH_TOKEN"]: profile.provider === "openai" ? "fixture.oauth.access" : "sk-ant-oat01-dispatch-fixture",
					...(prepared ? { PI_PACKAGES: stagedRoot } : {}),
				};
				const args = ["run", "--pull=never", "--rm", "--name", name, "-i", "--init", "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-v", `${job}:/job:ro`];
				if (prepared) args.push("-v", `${root}:${stagedRoot}:ro`);
				for (const [name, value] of Object.entries(env)) args.push("-e", `${name}=${value}`);
				args.push(image);
				const result = spawnSync("docker", args, { input: `${key}\n`, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
				const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
				const problems = subscriptionSmokeProblems({ output, status: result.status, key, provider: profile.provider, mode });
				assert.deepEqual(problems, [], `${profile.adapter} ${mode}: ${problems.join("; ")}\n${output}`);
				console.log(`subscription image holds: ${profile.adapter} ${mode}`);
			}
		}
	} finally {
		for (const name of containers) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifySubscriptionImage(process.argv[2]);
