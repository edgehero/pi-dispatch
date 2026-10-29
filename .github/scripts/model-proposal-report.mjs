/** Read only JSON bytes from integrity-checked npm archives. Candidate JavaScript is never loaded (#717). */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { catalogDiff, renderCatalogProposal } from "../../worker/src/model-proposals.mjs";
import { callCostBound } from "../../image/runner/src/usage-meter.mjs";

const LIMIT = 32 * 1024 * 1024;
export async function boundedBytes(response, limit = LIMIT) {
	if (!response.ok) throw new Error("model report download failed");
	let length = 0;
	const chunks = [];
	for await (const chunk of response.body) {
		length += chunk.length;
		if (length > limit) throw new Error("model report download too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export function catalogFromArchive(compressed, integrity) {
	if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) || `sha512-${createHash("sha512").update(compressed).digest("base64")}` !== integrity) throw new Error("model report integrity mismatch");
	const tar = gunzipSync(compressed, { maxOutputLength: LIMIT });
	const rows = [];
	const seen = new Set();
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((n) => n === 0)) break;
		const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
		const rawSize = header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim();
		if (!/^[0-7]+$/.test(rawSize)) throw new Error("invalid catalog archive size");
		const size = Number.parseInt(rawSize, 8);
		if (size > LIMIT || offset + 512 + size > tar.length) throw new Error("truncated catalog archive");
		if (/^package\/dist\/providers\/data\/[A-Za-z0-9._-]+\.json$/.test(name)) {
			if (![0, 48].includes(header[156]) || seen.has(name)) throw new Error("ambiguous catalog archive");
			seen.add(name);
			const data = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
			for (const byKey of Object.values(data)) for (const row of Object.values(byKey)) rows.push(row);
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (!seen.size) throw new Error("candidate has no JSON model catalog; report unavailable");
	return rows;
}

export async function registryCatalog(version, { fetch = globalThis.fetch } = {}) {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("exact catalog version required");
	const request = (url) => fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
	const metadata = JSON.parse((await boundedBytes(await request(`https://registry.npmjs.org/@earendil-works/pi-ai/${version}`), 2 * 1024 * 1024)).toString("utf8"));
	const tarball = metadata.dist?.tarball;
	if (metadata.name !== "@earendil-works/pi-ai" || metadata.version !== version || typeof tarball !== "string" || !tarball.startsWith("https://registry.npmjs.org/@earendil-works/pi-ai/-/") || new URL(tarball).origin !== "https://registry.npmjs.org") throw new Error("untrusted catalog metadata");
	return catalogFromArchive(await boundedBytes(await request(tarball)), metadata.dist.integrity);
}

export async function modelProposalReport(from, to, config, deps = {}) {
	if (!Array.isArray(config.providers) || !config.providers.length || !config.providers.every((p) => /^[a-z0-9-]+$/.test(p)) || !Array.isArray(config.capsUsd) || !config.capsUsd.length || !config.capsUsd.every((n) => Number.isFinite(n) && n > 0) || !Number.isInteger(config.outputTokens) || config.outputTokens < 1 || config.outputTokens > 1000000) throw new Error("invalid public model report configuration");
	const read = deps.catalog ?? ((v) => registryCatalog(v, deps));
	const [before, after] = await Promise.all([read(from), read(to)]);
	return renderCatalogProposal(catalogDiff(before, after, config.providers), config, callCostBound);
}
