/** Reviewed forge context supplies endpoint and credential; findings supply neither. */
export function makeWatchIssueAdapter({ getContext, fetchFn = fetch, maxPages = 10, timeoutMs = 10000 }) {
	if (typeof getContext !== "function" || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error("invalid watch issue adapter configuration");
	async function context(target) {
		if (!["github", "gitlab", "forgejo"].includes(target?.kind)) throw new Error("watch issue forge unsupported");
		if (typeof target.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repo) || target.repo.split("/").some(x => [".", ".."].includes(x))) throw new Error("invalid watch issue repository");
		const config = await getContext(target); const url = new URL(config.apiUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || typeof config.token !== "string" || !config.token) throw new Error("invalid watch issue API context");
		const base = url.href.replace(/\/$/, "");
		const repo = target.repo.split("/").map(encodeURIComponent).join("/");
		const root = target.kind === "gitlab" ? `${base}${url.pathname.replace(/\/$/, "").endsWith("/api/v4") ? "" : "/api/v4"}/projects/${encodeURIComponent(target.repo)}/issues` : target.kind === "forgejo" ? `${base}${url.pathname.replace(/\/$/, "").endsWith("/api/v1") ? "" : "/api/v1"}/repos/${repo}/issues` : `${base}/repos/${repo}/issues`;
		return { root, headers: target.kind === "gitlab" ? { "private-token": config.token } : { authorization: `Bearer ${config.token}` } };
	}
	async function request(ctx, suffix, method = "GET", data) {
		let res;
		try { res = await fetchFn(ctx.root + suffix, { method, redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { ...ctx.headers, accept: "application/json", ...(data ? { "content-type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); } catch { throw new Error("watch issue API unavailable"); }
		if (!res.ok) { await res.body?.cancel?.(); throw new Error("watch issue API refused request"); }
		if (Number(res.headers?.get?.("content-length")) > 1048576) { await res.body?.cancel?.(); throw new Error("watch issue response exceeds limit"); }
		const chunks = []; let bytes = 0;
		if (!res.body?.getReader) throw new Error("watch issue API response missing");
		const reader = res.body.getReader();
		try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1048576) throw new Error("watch issue response exceeds limit"); chunks.push(Buffer.from(value)); } } catch { await reader.cancel().catch(() => {}); throw new Error("watch issue response unavailable"); } finally { reader.releaseLock(); }
		try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("watch issue API response invalid"); }
	}
	function issueId(value, kind) { const id = kind === "gitlab" ? value?.iid : value?.number; if (!Number.isSafeInteger(id) || id < 1) throw new Error("watch issue API response invalid"); return { id }; }
	return {
		async createIssue({ target, title, body }) { const ctx = await context(target); const data = target.kind === "gitlab" ? { title, description: body } : { title, body }; return issueId(await request(ctx, "", "POST", data), target.kind); },
		async updateIssue({ target, id, title, body, state }) { if (!/^[1-9][0-9]{0,14}$/.test(String(id))) throw new Error("invalid watch issue id"); const ctx = await context(target); const data = { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? target.kind === "gitlab" ? { description: body } : { body } : {}), ...(state === "open" ? target.kind === "gitlab" ? { state_event: "reopen" } : { state: "open" } : {}) }; await request(ctx, `/${id}`, target.kind === "gitlab" ? "PUT" : "PATCH", data); },
		async closeIssue({ target, id }) { if (!/^[1-9][0-9]{0,14}$/.test(String(id))) throw new Error("invalid watch issue id"); const ctx = await context(target); await request(ctx, `/${id}`, target.kind === "gitlab" ? "PUT" : "PATCH", target.kind === "gitlab" ? { state_event: "close" } : { state: "closed" }); },
		async findIssue({ target, marker }) {
			if (typeof marker !== "string" || !/^pi-dispatch-watch:[a-f0-9]{64}$/.test(marker)) throw new Error("invalid watch issue marker");
			const ctx = await context(target);
			for (let page = 1; page <= maxPages; page++) {
				const rows = await request(ctx, `?state=all&${target.kind === "forgejo" ? "limit" : "per_page"}=100&page=${page}`);
				if (!Array.isArray(rows) || rows.length > 100) throw new Error("watch issue API response invalid");
				const found = rows.filter(row => !row.pull_request && String(target.kind === "gitlab" ? row.description ?? "" : row.body ?? "").includes(`<!-- ${marker} -->`));
				if (found.length > 1) throw new Error("watch issue marker ambiguous");
				if (found.length === 1) return issueId(found[0], target.kind);
				if (rows.length < 100) return null;
			}
			throw new Error("watch issue reconciliation page limit reached");
		},
	};
}
