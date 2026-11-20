/** Replace only this connection's superseded access bearer, never its model, account or billing route. */
export function subscriptionRefreshFetch({ credentials, refresh = () => {}, fetch = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => performance.now(), checks = 20 }) {
	return async (input, init) => {
		let url;
		try { url = new URL(input); } catch { return fetch(input, init); }
		if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages" || url.username || url.password || init?.method !== "POST" || typeof init.body !== "string") return fetch(input, init);
		const headers = new Headers(init.headers);
		const bearer = headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
		const admitted = credentials?.issued?.("anthropic", bearer);
		if (!admitted || headers.has("x-api-key")) return fetch(input, init);
		let sent = admitted;
		const update = () => {
			refresh();
			const next = credentials.current("anthropic");
			if (!next || next.connectionId !== sent.connectionId || next.generation <= sent.generation || next.token === sent.token) return false;
			sent = next;
			headers.set("authorization", `Bearer ${next.token}`);
			return true;
		};
		// Request shaping may await after model admission. Catch a rotation during those awaits
		// at the transport boundary, leaving the already-checked body and every other header intact.
		update();
		init.signal?.throwIfAborted();
		const request = { ...init, headers };
		const response = await fetch(input, request);
		if (response.status !== 401) return response;
		const deadline = now() + 2000;
		// A 401 supplies no model output. It is retried ONCE only if the trusted drop proves this
		// very connection has a newer generation. A revoked current grant still returns the 401.
		for (let i = 0; i <= checks; i++) {
			init.signal?.throwIfAborted();
			if (now() >= deadline) return response;
			if (update()) {
				if (now() >= deadline) return response;
				void response.body?.cancel().catch(() => {});
				return fetch(input, { ...request, headers: new Headers(headers) });
			}
			if (i < checks) await sleep(100);
		}
		return response;
	};
}
