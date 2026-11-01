/** Audited adaptations of MIT community packages. No extension executes while staging or verifying. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, dirname, isAbsolute } from "node:path";
import { COMMUNITY_SOURCE_PINS } from "./community-auth-pins.mjs";
import { COMMUNITY_ADAPTED_SOURCE_PINS } from "./community-auth-output-pins.mjs";

import { COMMUNITY_AUTH_ADAPTERS } from "./community-auth-metadata.mjs";
export { COMMUNITY_AUTH_ADAPTERS } from "./community-auth-metadata.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
function replaceOnce(source, before, after) {
	if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) fail("auth-adapter-source-mismatch");
	return source.replace(before, after);
}

export function adaptCommunitySource(adapter, path, input) {
	let source = input;
	if (adapter === "pi-anthropic-oauth@0.3.6") {
		if (path === "src/index.ts") {
			source = replaceOnce(source, 'name: "Claude Pro/Max",', 'name: "Claude Pro/Max",\n      isSubscription: true,');
			source = replaceOnce(source, '  pi.registerProvider("anthropic", {', '  Object.defineProperty(streamAnthropicOAuth, Symbol.for("pi-dispatch.subscription-adapter"), { value: "pi-anthropic-oauth@0.3.6" });\n  pi.registerProvider("anthropic", {');
		}
		if (path === "src/auth.ts") {
			source = replaceOnce(source, "callbacks: OAuthLoginCallbacks,\n):", "callbacks: OAuthLoginCallbacks,\n  now: () => number = Date.now,\n):");
			source = replaceOnce(source, "credentials: OAuthCredentials,\n):", "credentials: OAuthCredentials,\n  signal?: AbortSignal,\n  now: () => number = Date.now,\n):");
			source = replaceOnce(source, 'headers: makeTokenHeaders(),\n        body: JSON.stringify({\n          grant_type: "refresh_token",', 'headers: makeTokenHeaders(),\n        signal,\n        body: JSON.stringify({\n          grant_type: "refresh_token",');
			source = replaceOnce(source, '    if (isTransientTokenError(error) && credentials.expires > Date.now()) {\n      return { ...credentials, expires: Date.now() + 30_000 };\n    }\n', "");
			source = source.replaceAll("expires: Date.now() + data.expires_in", "expires: now() + data.expires_in");
			source = replaceOnce(source, "    const response = await fetch(url, init);", "    init.signal?.throwIfAborted();\n    const response = await dispatchFetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(15_000)]) });");
			source = replaceOnce(source, "      await new Promise((resolve) => setTimeout(resolve, delayMs));", "      await new Promise<void>((resolve, reject) => {\n        const done = () => { init.signal?.removeEventListener(\"abort\", abort); resolve(); };\n        const timer = setTimeout(done, delayMs);\n        const abort = () => { clearTimeout(timer); reject(new Error(\"auth-network-unavailable\")); };\n        init.signal?.addEventListener(\"abort\", abort, { once: true });\n        if (init.signal?.aborted) abort();\n      });");
			source = replaceOnce(source, '      `${label} failed: ${response.status} ${bodyText}`,', '      `auth-token-http-${response.status}`,');
			source = replaceOnce(source, '    throw new Error(`Token refresh failed: ${detail}`);', '    throw error;');
			source = replaceOnce(source, "    localAuthorization = await createLocalAuthorization(state);", "    localAuthorization = await createLocalAuthorization(state);\n    callbacks.signal?.addEventListener(\"abort\", () => localAuthorization?.cancel(), { once: true });\n    if (callbacks.signal?.aborted) localAuthorization.cancel();");
			source = 'let dispatchFetch: typeof fetch = globalThis.fetch;\nexport function configureDispatchAuth(transport: typeof fetch) { dispatchFetch = transport; }\n' + source;
		}
		if (path === "src/prompt.ts") {
			const start = source.indexOf("  const paragraphs = text.split(");
			const end = source.indexOf("\n}\n\nfunction resolvePiRewritePattern", start);
			if (start < 0 || end < start) fail("auth-adapter-source-mismatch");
			source = source.slice(0, start) + "  return text;" + source.slice(end);
		}
		if (path === "src/convert.ts") {
			source = replaceOnce(source, "export function convertPiToolsToAnthropic(tools: Tool[], isOAuth: boolean): ToolUnion[] {", "export function convertPiToolsToAnthropic(tools: Tool[], isOAuth: boolean): ToolUnion[] {\n  const names = tools.map((tool) => isOAuth ? toClaudeCodeToolName(tool.name) : tool.name);\n  if (new Set(names).size !== names.length) throw new Error(\"auth-tool-name-collision\");");
		}
		if (path === "src/stream.ts") {
			source = replaceOnce(source, "        dangerouslyAllowBrowser: true,", "        dangerouslyAllowBrowser: true,\n        fetch: options?.fetch,");
			source = replaceOnce(source, "      // Raw stream instead of the MessageStream helper:", "      const checkedParams = (await options?.onPayload?.(params, model)) ?? params;\n\n      // Raw stream instead of the MessageStream helper:");
			source = replaceOnce(source, ".create(params, {", ".create(checkedParams as MessageCreateParamsStreaming, {");
			source = replaceOnce(source, "        } catch {\n          // Response hooks are best-effort and should not break streaming.\n        }", "        } catch (error) { throw error; }");
			source = replaceOnce(source, "  cache_creation_input_tokens?: number | null;", "  cache_creation_input_tokens?: number | null;\n  cache_creation?: { ephemeral_1h_input_tokens?: number | null };");
			source = replaceOnce(source, "    const thinkingTokens = usage.output_tokens_details?.thinking_tokens;", "    if (usage.cache_creation?.ephemeral_1h_input_tokens != null) output.usage.cacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens;\n    const thinkingTokens = usage.output_tokens_details?.thinking_tokens;");
			source = replaceOnce(source, "            output.usage.totalTokens =", "            output.usage.cacheWrite1h = (event.message.usage as MessageDeltaUsage).cache_creation?.ephemeral_1h_input_tokens ?? 0;\n            output.usage.totalTokens =");
		}
	}
	if (adapter === "@gotgenes/pi-anthropic-auth@3.4.3" && path === "src/oauth-transport.ts") {
		// Shape first, then let the dispatch model/payload/cost guards inspect what will actually be sent.
		source = replaceOnce(source, "      const upstream = await composeCallerOnPayload(payload, payloadModel);", "      const upstream = payload;");
		source = replaceOnce(source, "        return upstream;", "        return composeCallerOnPayload(upstream, payloadModel);");
		source = replaceOnce(source, "      versionSync?.recordRequest(upstream);\n      return shapeAnthropicOAuthPayload(upstream);", "      const checked = await composeCallerOnPayload(shapeAnthropicOAuthPayload(upstream), payloadModel);\n      versionSync?.recordRequest(checked);\n      return checked;");
		// Keep the caller's measured fetch. No body rewrite or second request may follow the final payload check.
		source = replaceOnce(source, "      ...(versionSync ? { fetch: versionSync.fetch } : {}),", "");
	}
	if (adapter === "@gotgenes/pi-anthropic-auth@3.4.3" && path === "src/index.ts") source = replaceOnce(source, '  pi.unregisterProvider("anthropic");', '  Object.defineProperty(streamSimple, Symbol.for("pi-dispatch.subscription-adapter"), { value: "@gotgenes/pi-anthropic-auth@3.4.3" });\n  pi.unregisterProvider("anthropic");');
	if (adapter === "@gotgenes/pi-anthropic-auth@3.4.3" && path === "src/system-prompt-shaping.ts") {
		for (const [signature, next, returned] of [
			["export function shapeAnthropicOAuthSystemPrompt(systemPrompt: string): string {", "\n}\n\nfunction isPiOwnedSection", "systemPrompt"],
			["export function shapeSystemUpdateText(text: string): string | undefined {", "\n}\n\n/**\n * Apply the rule table", "text"],
		]) {
			const start = source.indexOf(signature);
			const end = source.indexOf(next, start);
			if (start < 0 || end < start) fail("auth-adapter-source-mismatch");
			source = source.slice(0, start + signature.length) + `\n  return ${returned};` + source.slice(end);
		}
		const signature = "export function shapeSystemBlocks(blocks: TextBlock[]): TextBlock[] {";
		const start = source.indexOf(signature);
		if (start < 0 || !source.trimEnd().endsWith("}")) fail("auth-adapter-source-mismatch");
		source = source.slice(0, start + signature.length) + "\n  return blocks;\n}\n";
	}
	return source;
}

// A changed adaptation must be explicitly restaged even when the upstream package version stays the same.
export const COMMUNITY_ADAPTER_REVISION = sha(JSON.stringify(COMMUNITY_SOURCE_PINS) + adaptCommunitySource.toString());

function regularFile(fs, path) { const stat = fs.lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) fail("auth-adapter-unsafe-path"); return stat; }
export function communityPackageDigest(root, { fs = nodeFs } = {}) {
	let files = 0;
	let bytes = 0;
	const entries = [];
	function walk(path) {
		const stat = fs.lstatSync(path);
		if (stat.isSymbolicLink()) fail("auth-adapter-unsafe-path");
		if (stat.isDirectory()) { for (const name of fs.readdirSync(path).sort()) if (join(path, name) !== join(root, ".dispatch-auth-adapter.json")) walk(join(path, name)); return; }
		if (!stat.isFile() || ++files > 20_000 || (bytes += stat.size) > 150 * 1024 * 1024) fail("auth-adapter-tree-unbounded");
		entries.push(`${relative(root, path).split("\\").join("/")}\0${sha(fs.readFileSync(path))}\0`);
	}
	walk(root);
	return sha(entries.sort().join(""));
}

function packageCheck(adapter, root, fs) {
	if (typeof root !== "string" || !isAbsolute(root)) fail("auth-adapter-unsafe-path");
	const pin = COMMUNITY_AUTH_ADAPTERS[adapter];
	if (!pin?.community) fail("auth-adapter-unsupported");
	regularFile(fs, join(root, "package.json"));
	const pkg = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
	if (pkg.name !== pin.package || pkg.version !== pin.version) fail("auth-adapter-version-mismatch");
	if (adapter === "pi-anthropic-oauth@0.3.6") {
		const path = join(root, "node_modules/@anthropic-ai/sdk/package.json");
		regularFile(fs, path);
		const sdk = JSON.parse(fs.readFileSync(path, "utf8"));
		if (sdk.name !== "@anthropic-ai/sdk" || sdk.version !== "0.124.0") fail("auth-adapter-version-mismatch");
	}
	const seen = new Set();
	function dependencies(directory) {
		if (seen.has(directory)) return;
		seen.add(directory);
		const manifestPath = join(directory, "package.json");
		regularFile(fs, manifestPath);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		for (const name of Object.keys(manifest.dependencies ?? {})) {
			if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) fail("auth-adapter-dependencies-unresolved");
			let search = directory;
			let resolved;
			while (search === root || search.startsWith(`${root}/`)) {
				const candidate = join(search, "node_modules", name);
				if (fs.existsSync(join(candidate, "package.json"))) { resolved = candidate; break; }
				search = dirname(search);
			}
			if (!resolved) fail("auth-adapter-dependencies-unresolved");
			dependencies(resolved);
		}
	}
	dependencies(root);
	return pin;
}

export function prepareCommunityAuthAdapter({ adapter, root, fs = nodeFs }) {
	const pin = packageCheck(adapter, root, fs);
	const outputs = {};
	for (const [path, expected] of Object.entries(COMMUNITY_SOURCE_PINS[adapter])) {
		regularFile(fs, join(root, path));
		const original = fs.readFileSync(join(root, path), "utf8");
		if (sha(original) !== expected) fail("auth-adapter-source-mismatch");
		outputs[path] = adaptCommunitySource(adapter, path, original);
	}
	// Verify every source before changing one; partial staging never receives an approval receipt.
	for (const [path, source] of Object.entries(outputs)) fs.writeFileSync(join(root, path), source);
	const digest = communityPackageDigest(root, { fs });
	const receipt = { version: 1, adapter, adapterRevision: COMMUNITY_ADAPTER_REVISION, package: pin.package, packageVersion: pin.version, digest, sources: Object.fromEntries(Object.entries(outputs).map(([path, source]) => [path, sha(source)])) };
	fs.writeFileSync(join(root, ".dispatch-auth-adapter.json"), JSON.stringify(receipt));
	return { adapter, package: pin.package, version: pin.version, digest };
}

export function verifyCommunityAuthAdapter({ adapter, root, digest, fs = nodeFs }) {
	if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) fail("auth-adapter-unpinned");
	const pin = packageCheck(adapter, root, fs);
	regularFile(fs, join(root, ".dispatch-auth-adapter.json"));
	const receipt = JSON.parse(fs.readFileSync(join(root, ".dispatch-auth-adapter.json"), "utf8"));
	if (receipt.version !== 1 || receipt.adapter !== adapter || receipt.adapterRevision !== COMMUNITY_ADAPTER_REVISION || receipt.digest !== digest || communityPackageDigest(root, { fs }) !== digest) fail("auth-adapter-unpinned");
	for (const path of Object.keys(COMMUNITY_SOURCE_PINS[adapter])) {
		regularFile(fs, join(root, path));
		const actual = sha(fs.readFileSync(join(root, path)));
		if (actual !== receipt.sources?.[path] || actual !== COMMUNITY_ADAPTED_SOURCE_PINS[adapter]?.[path]) fail("auth-adapter-source-mismatch");
	}
	return { adapter, package: pin.package, version: pin.version, digest, compatibility: "verified" };
}
