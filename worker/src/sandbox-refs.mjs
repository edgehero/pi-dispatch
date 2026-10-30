/** Checked references for a human's sandbox; no job or agent accepts this broader checkout surface (#771). */
import { FORGE_KINDS } from "./forges.mjs";
import { isDeterminateFetchFailure, isTransientStatus } from "./transient.mjs";

export const SANDBOX_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const refuse = (refused, message) => ({ refused, message });

export function sandboxRepoProblem(repo, kind) {
	if (!FORGE_KINDS.includes(kind)) return "choose a forge-backed trigger; a local-folder trigger cannot clone a repository";
	if (typeof repo !== "string" || repo.length > 300 || repo !== repo.trim() || /[\u0000-\u001f\u007f\\:@?#%]/.test(repo)) return "repository must be a plain forge repository path, without a URL or credential";
	const parts = repo.split("/");
	if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith("-") || p.endsWith(".git"))) return "repository has an invalid path segment";
	if ((kind === "gitlab" && parts.length < 2) || (kind !== "gitlab" && parts.length !== 2)) return kind === "gitlab" ? "GitLab repository must name its full group/project path" : "repository must have exactly two path segments";
	if (parts.some((p) => !/^[\p{L}\p{N}._ -]+$/u.test(p))) return "repository has an unsupported path character";
	return null;
}

/** pr:42 is deliberately distinct from a branch named 42. Fully qualified heads/tags are also accepted. */
export function parseSandboxRef(ref = "HEAD", kind = "github") {
	if (typeof ref !== "string" || ref.length === 0 || ref.length > 200 || ref !== ref.trim()) return refuse("sandbox-ref-invalid", "ref must be HEAD, a branch or tag, a full commit id, or pr:<number>");
	const pull = /^(?:pr|mr):([1-9]\d{0,9})$/.exec(ref);
	if (pull) {
		if (!FORGE_KINDS.includes(kind)) return refuse("sandbox-ref-invalid", "pull request refs need a forge-backed trigger");
		return { type: "pull_request", number: Number(pull[1]), ref };
	}
	if (SANDBOX_SHA_RE.test(ref)) return { type: "sha", fetchRef: ref, ref };
	// This is Git's ref-name grammar, with '-' and ':' additionally closed before the value reaches fetch's argv.
	if (ref.startsWith("-") || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref === "@" || ref.endsWith(".") || ref.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".lock"))) return refuse("sandbox-ref-invalid", "ref is not a safe Git reference; use a branch, tag, full commit id, or pr:<number>");
	return { type: "ref", fetchRef: ref, ref };
}

/** A tokenless origin made only from host configuration and a checked repository, never a request-supplied URL. */
export function sandboxRemoteUrl(kind, repo, config) {
	const problem = sandboxRepoProblem(repo, kind);
	if (problem) throw new Error(problem);
	const parts = repo.split("/").map(encodeURIComponent);
	let root;
	if (kind === "github") root = "https://github.com";
	else root = kind === "azure" ? config?.azure?.orgUrl : config?.[kind]?.apiUrl;
	let url;
	try { url = new URL(root); } catch { throw new Error("the selected forge has no valid configured URL"); }
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("the selected forge requires a credential-free http(s) URL");
	const base = url.href.replace(/\/+$/, "");
	return kind === "azure" ? `${base}/${parts[0]}/_git/${parts[1]}` : `${base}/${parts.join("/")}.git`;
}

/** GitHub, GitLab and Forgejo serve a PR head on the base repository. Azure exposes its source commit through API. */
export async function resolveSandboxRef({ kind, repo, ref, config, token, fetchFn = fetch, signal } = {}) {
	const parsed = parseSandboxRef(ref, kind);
	if (parsed.refused) return parsed;
	if (parsed.type !== "pull_request") return { fetchRef: parsed.fetchRef };
	if (kind !== "azure") return { fetchRef: kind === "gitlab" ? `refs/merge-requests/${parsed.number}/head` : `refs/pull/${parsed.number}/head` };
	const [project, repository] = repo.split("/").map(encodeURIComponent);
	const root = new URL(config.azure.orgUrl).href.replace(/\/+$/, "");
	let response;
	try {
		response = await fetchFn(`${root}/${project}/_apis/git/repositories/${repository}/pullrequests/${parsed.number}?api-version=7.1`, { headers: { Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, accept: "application/json" }, redirect: "error", signal: signal ?? AbortSignal.timeout(30_000) });
	} catch (error) {
		if (isDeterminateFetchFailure(error)) return refuse("sandbox-ref-unavailable", "the forge connection configuration prevents resolving this pull request");
		throw new Error("sandbox pull request lookup did not answer", { cause: error });
	}
	if (!response.ok) {
		if (isTransientStatus(response.status, (name) => response.headers?.get?.(name), "")) throw new Error("sandbox pull request lookup temporarily failed");
		return refuse("sandbox-ref-unavailable", "the selected pull request could not be read with this host's forge credential");
	}
	const data = await response.json();
	const sha = data?.lastMergeSourceCommit?.commitId;
	if (!SANDBOX_SHA_RE.test(sha ?? "")) return refuse("sandbox-ref-unavailable", "the pull request does not report a source commit");
	return { fetchRef: sha };
}
