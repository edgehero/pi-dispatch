import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { GATEWAY_ID_RE, GATEWAY_PENDING_MS, GATEWAY_GRANT_MS, GATEWAY_AUTH_MS, gatewayHash, gatewayRandom, gatewayTargetKey } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { gatewayDimensions, GATEWAY_LIMITS } from "./terminal-protocol.mjs";
import { runGatewaySession } from "./session.mjs";
import { gatewayPage } from "./page.mjs";

const cookieName = secure => secure ? "__Host-pdg_browser" : "pdg_browser";
const idOk = (s) => typeof s === "string" && GATEWAY_ID_RE.test(s) && Buffer.from(s, "base64url").toString("base64url") === s;
export function gatewayCookie(value, { secure = false } = {}) { return `${cookieName(secure)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil((GATEWAY_PENDING_MS + GATEWAY_GRANT_MS + GATEWAY_LIMITS.upgradeMs) / 1000)}${secure ? "; Secure" : ""}`; }
const cookieValues = (header, secure) => String(header ?? "").split(";").map((s) => s.trim()).filter((s) => s.startsWith(`${cookieName(secure)}=`)).map((s) => s.slice(cookieName(secure).length + 1));
export function readGatewayCookie(header, { secure = false } = {}) {
	const values = cookieValues(header, secure);
	return values.length === 1 && idOk(values[0]) ? values[0] : null;
}
export function gatewayHeaders(origin) {
	const socketOrigin = origin.replace(/^http/, "ws");
	return { "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${socketOrigin}; img-src 'self' data:; font-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin", "x-frame-options": "DENY", "cache-control": "no-store", "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()" };
}
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
async function body(req) {
	if (req.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") throw new Error("content-type");
	const chunks = []; let size = 0;
	for await (const c of req) { size += c.length; if (size > GATEWAY_LIMITS.bodyBytes) throw new Error("body-limit"); chunks.push(c); }
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createGatewayServer({ config, store, runtime, assets, audit, now = () => performance.now(), random = gatewayRandom, log = () => {}, sessionFn = runGatewaySession } = {}) {
	const admitted = new Map(), sessions = new Map(), reserved = new Set();
	const expectedHost = new URL(config.origin).host;
	const secure = new URL(config.origin).protocol === "https:";
	const stopWatches = (driverConnectionId, { reason = "driver-ended", watcherKey = null } = {}) => {
		for (const s of sessions.values()) if (s.intent?.kind === "watch" && s.intent.driver.connectionId === driverConnectionId && (!watcherKey || gatewayHash(s.intent.intentId) === watcherKey)) void s.finish(reason);
	};
	const enrolled = (m) => m?.gatewayOrigin === config.origin && m?.consoleOrigin === config.consoleOrigin && m?.target?.host === config.host && config.sockets[m.target.venue];
	const hostOk = (req) => req.headers.host === expectedHost && req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "host").length === 1;
	const originOk = (req) => req.headers.origin === config.origin && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
	function sweep() {
		for (const [id, a] of admitted) if (!a.upgrading && now() >= a.until) { admitted.delete(id); reserved.delete(id); void store.release({ intentId: a.intent.intentId, connectionId: id, reason: "disconnected" }).catch(() => {}); }
	}
	const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
		let reservation = null, consumed = null;
		for (const [key, value] of Object.entries(gatewayHeaders(config.origin))) res.setHeader(key, value);
		try {
			if (!hostOk(req) || !req.url?.startsWith("/") || req.url.startsWith("//")) { json(res, 421, { error: "host" }); return; }
			const url = new URL(req.url, config.origin);
			if (url.search) { json(res, 404, { error: "not-found" }); return; }
			if (req.method === "GET" && (url.pathname === "/workbench" || /^\/s\/[A-Za-z0-9_-]{43}$/.test(url.pathname))) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(gatewayPage({ consoleOrigin: config.consoleOrigin })); return; }
			const staticAssets = { "/static/gateway.js": [assets.script, "text/javascript"], "/static/terminal.js": [assets.terminalScript, "text/javascript"], "/static/gateway.css": [assets.css, "text/css"] };
			if (req.method === "GET" && Object.hasOwn(staticAssets, url.pathname)) { const [source, type] = staticAssets[url.pathname]; res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(source); return; }
			if (req.method !== "POST" || !["/api/bootstrap", "/api/connect"].includes(url.pathname)) { json(res, 404, { error: "not-found" }); return; }
			if (!originOk(req)) { json(res, 403, { error: "origin" }); return; }
			let m; try { m = await body(req); } catch { json(res, 400, { error: "body-invalid" }); return; }
			if (!m || typeof m !== "object" || Array.isArray(m) || !idOk(m.intentId)) { json(res, 400, { error: "intent-invalid" }); return; }
			const cookie = readGatewayCookie(req.headers.cookie, { secure });
			if (url.pathname === "/api/bootstrap") {
				if (Object.keys(m).sort().join() !== "handoff,intentId" || !idOk(m.handoff) || cookieValues(req.headers.cookie, secure).length && !cookie) { json(res, 400, { error: "handoff-invalid" }); return; }
				const nonce = cookie ?? random(), receipt = random();
				const result = await store.bindIntent({ intentId: m.intentId, handoff: m.handoff, browserHash: gatewayHash(nonce), receiptHash: gatewayHash(receipt), gatewayOrigin: config.origin, host: config.host });
				if (!result.ok || !enrolled(result.intent)) { json(res, 409, { error: result.refused ?? "enrollment-changed" }); return; }
				res.setHeader("set-cookie", gatewayCookie(nonce, { secure }));
				json(res, 200, { authorizeUrl: `${config.consoleOrigin}/sandbox/gateway/authorize?intent=${m.intentId}`, receipt }); return;
			}
			if (Object.keys(m).sort().join() !== "cols,intentId,rows,sessionKey,width" || !(m.sessionKey === null || typeof m.sessionKey === "string" && /^[a-f0-9]{64}$/.test(m.sessionKey)) || !Number.isInteger(m.width) || m.width < GATEWAY_LIMITS.minimumWidth || !gatewayDimensions(m.cols, m.rows)) { json(res, 400, { error: "dimensions" }); return; }
			if (!cookie) { json(res, 403, { error: "browser-missing" }); return; }
			sweep();
			if (reserved.size >= GATEWAY_LIMITS.connections) { json(res, 429, { error: "connection-limit" }); return; }
			const connectionId = random();
			if (reserved.has(connectionId)) { json(res, 503, { error: "connection-limit" }); return; }
			reserved.add(connectionId); reservation = connectionId;
			const intent = await store.readIntent(m.intentId);
			if (!enrolled(intent) || intent.browserHash !== gatewayHash(cookie)) { json(res, 409, { error: "intent-unavailable" }); return; }
			if (m.sessionKey !== null && intent.sessionKey !== m.sessionKey) { json(res, 409, { error: "workbench-session-changed" }); return; }
			const result = await store.redeem({ intentId: m.intentId, browserHash: gatewayHash(cookie), connectionId });
			if (!result.ok) {
				json(res, 409, { error: result.refused, ...(result.refused === "window-busy" && idOk(result.winnerConnectionId) ? { kind: intent.kind, targetKey: gatewayTargetKey(intent.target), ownerKey: gatewayHash(result.winnerConnectionId), host: intent.target.host, id: intent.target.id } : {}) }); return;
			}
			consumed = result.intent;
			const room = result.intent.kind === "watch" ? await store.readRoom(result.intent.target) : null;
			if (result.intent.kind === "watch" && (!room || room.driverConnectionId !== result.intent.driver.connectionId || room.epoch !== result.intent.driver.epoch)) { json(res, 409, { error: "driver-ended" }); return; }
			const observation = await runtime.inspect(result.intent.target);
			if (!observation.ok) { json(res, 409, { error: ["runtime-environment", "sandbox-ended"].includes(observation.refused) ? observation.refused : "runtime-unavailable" }); return; }
			admitted.set(connectionId, { intent: result.intent, driverActor: room?.driverActor, browserHash: gatewayHash(cookie), cols: m.cols, rows: m.rows, until: now() + GATEWAY_LIMITS.upgradeMs });
			reservation = null; consumed = null;
			json(res, 200, { connectionId, kind: result.intent.kind, sessionKey: result.intent.sessionKey, targetKey: gatewayTargetKey(result.intent.target), ownerKey: gatewayHash(connectionId), runFacts: result.intent.runFacts, host: intent.target.host, id: intent.target.id, by: result.intent.actor.name, startedAt: result.intent.connectedAt, idleMinutes: config.idleMinutes, theme: intent.theme, ...(room ? { driver: { name: room.driverActor.name, ownerKey: gatewayHash(room.driverConnectionId) }, geometry: room.geometry } : {}) });
		} catch { log("gateway_request_failed"); if (!res.headersSent) json(res, 503, { error: "control-unavailable" }); else res.end(); }
		finally { if (reservation) { reserved.delete(reservation); if (consumed) await store.release({ intentId: consumed.intentId, connectionId: reservation, reason: "runtime-unavailable" }).catch(() => {}); } }
	});
	const wss = new WebSocketServer({ noServer: true, maxPayload: GATEWAY_LIMITS.frameBytes, perMessageDeflate: false, maxFragments: 128, maxBufferedChunks: 128 });
	server.on("upgrade", async (req, socket, head) => {
		// Node takes an upgraded socket out of its HTTP error handling, and ws adds a listener only inside handleUpgrade,
		// so until then a reset is an unhandled "error" that ends the whole process: measured from an unauthenticated client.
		socket.on("error", () => {});
		// end() alone only half-closes. A client that ignores the FIN would hold a connection slot here with no timeout left.
		const refuse = () => { if (!socket.destroyed) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy()); };
		let a, connectionId;
		const discard = async (reason) => {
			if (!a) return;
			admitted.delete(connectionId); reserved.delete(connectionId);
			await store.release({ intentId: a.intent.intentId, connectionId, reason }).catch(() => {});
		};
		try {
			sweep();
			const match = /^\/socket\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? "");
			const cookie = readGatewayCookie(req.headers.cookie, { secure });
			if (!hostOk(req) || !originOk(req) || !match || !cookie || req.headers["sec-websocket-protocol"]) { refuse(); return; }
			connectionId = match[1]; a = admitted.get(connectionId);
			if (!a || a.upgrading || a.browserHash !== gatewayHash(cookie)) { refuse(); return; }
			a.upgrading = true;
			const requestedAt = now();
			const authority = await store.renewAttachment({ intentId: a.intent.intentId, connectionId, browserHash: a.browserHash });
			if (!authority.ok || !Number.isFinite(authority.authRemainingMs) || authority.authRemainingMs <= 0 || authority.authRemainingMs > GATEWAY_AUTH_MS || now() - requestedAt >= authority.authRemainingMs) throw new Error("authorization-unavailable");
			if (socket.destroyed) throw new Error("disconnected");
			let upgraded = false;
			wss.handleUpgrade(req, socket, head, (ws) => {
				upgraded = true;
				// Let ws finish its own key/version/framing checks before touching the runtime. No
				// client input is accepted until the later ready receipt; there is no replay queue.
				const controller = new AbortController();
				let channel, cancelled = false, handedOff = false, opening = false;
				const endPending = async (reason) => {
					if (cancelled || handedOff) return;
					cancelled = true; clearTimeout(deadlineTimer); controller.abort(); channel?.detach();
					try { if (ws.readyState === 1) { ws.send(JSON.stringify({ type: "ended", reason })); ws.close(1000, reason); } } catch { ws.terminate(); }
					await discard(reason);
					if (opening) await audit("end", { ...a.intent, ...(a.driverActor ? { driverActor: a.driverActor } : {}) }, connectionId, reason).catch(() => log("gateway_end_audit_failed"));
					sessions.delete(connectionId);
				};
				const earlyInput = () => { void endPending("protocol-error"); };
				ws.on("message", earlyInput);
				ws.once("close", () => { void endPending("disconnected"); });
				ws.once("error", () => { void endPending("disconnected"); });
				let expiresAt = Math.min(a.until, requestedAt + authority.authRemainingMs), deadlineTimer;
				const armDeadline = () => { clearTimeout(deadlineTimer); deadlineTimer = setTimeout(() => { void endPending("authorization-unavailable"); }, Math.max(0, expiresAt - now())); deadlineTimer.unref(); };
				armDeadline();
				sessions.set(connectionId, { finish: endPending, intent: a.intent });
				void (async () => {
					try {
						let current = authority;
						while (a.intent.kind === "watch" && !current.rosterSeen) {
							if (cancelled || now() >= expiresAt) { await endPending("authorization-unavailable"); return; }
							await new Promise(resolve => setTimeout(resolve, GATEWAY_LIMITS.pollMs));
							if (cancelled) return;
							const polledAt = now();
							current = await store.renewAttachment({ intentId: a.intent.intentId, connectionId, browserHash: a.browserHash });
							if (cancelled) return;
							if (!current.ok) { await endPending(["watch-disabled", "watch-removed", "driver-ended"].includes(current.refused) ? current.refused : "authorization-unavailable"); return; }
							if (!Number.isFinite(current.authRemainingMs) || current.authRemainingMs <= 0 || current.authRemainingMs > GATEWAY_AUTH_MS) { await endPending("authorization-unavailable"); return; }
							// The reply describes authority at this request's start, never five new seconds
							// after a delayed response. New observations may only shorten this admission.
							expiresAt = Math.min(expiresAt, polledAt + current.authRemainingMs); armDeadline();
						}
						if (cancelled) return;
						if (now() >= expiresAt) { await endPending("authorization-unavailable"); return; }
						const auditedIntent = { ...a.intent, ...(a.driverActor ? { driverActor: a.driverActor } : {}) };
						opening = true;
						try { await audit("opening", auditedIntent, connectionId); } catch { await endPending("audit-unavailable"); return; }
						if (cancelled) return;
						// Timer delivery can lag promise continuations. A synchronous deadline check is
						// required before the runtime side effect even when its timeout has not fired.
						if (now() >= expiresAt) { await endPending("authorization-unavailable"); return; }
						channel = a.intent.kind === "watch" ? await runtime.attachWatch(a.intent.target, { signal: controller.signal }) : await runtime.attach(a.intent.target, { cols: a.cols, rows: a.rows, signal: controller.signal });
						if (cancelled) { channel.detach(); return; }
						if (now() >= expiresAt) { await endPending("authorization-unavailable"); return; }
						if (ws.readyState !== 1) { await endPending("disconnected"); return; }
						try { await audit("open", auditedIntent, connectionId); } catch { await endPending("audit-unavailable"); return; }
						if (cancelled) return;
						if (now() >= expiresAt) { await endPending("authorization-unavailable"); return; }
						const liveRequestedAt = now();
						const live = a.intent.kind === "watch" ? await store.readyWatch({ intentId: a.intent.intentId, connectionId, browserHash: a.browserHash }) : await store.startDriver({ intentId: a.intent.intentId, connectionId, browserHash: a.browserHash, cols: a.cols, rows: a.rows });
						if (!live.ok || !live.room) { await endPending(["watch-disabled", "watch-removed", "driver-ended"].includes(live.refused) ? live.refused : "authorization-unavailable"); return; }
						if (!Number.isFinite(live.authRemainingMs) || live.authRemainingMs <= 0 || live.authRemainingMs > GATEWAY_AUTH_MS) { await endPending("authorization-unavailable"); return; }
						const remaining = Math.min(expiresAt, liveRequestedAt + live.authRemainingMs) - now();
						if (cancelled || remaining <= 0 || ws.readyState !== 1) { await endPending("authorization-unavailable"); return; }
						clearTimeout(deadlineTimer); admitted.delete(connectionId); ws.removeListener("message", earlyInput);
						const active = sessionFn({ ws, channel, store, intent: auditedIntent, connectionId, browserHash: a.browserHash, room: live.room, authRemainingMs: Math.min(remaining, live.authRemainingMs), idleMinutes: config.idleMinutes, runtime, audit, now, onLocalStop: change => stopWatches(connectionId, change), onClosing: () => { if (a.intent.kind === "drive") stopWatches(connectionId); }, onEnd: ({ auditFailed }) => { sessions.delete(connectionId); reserved.delete(connectionId); if (auditFailed) log("gateway_end_audit_failed"); } });
						handedOff = true; sessions.set(connectionId, { ...active, intent: a.intent }); ws.send(JSON.stringify({ type: "ready" }));
					} catch { await endPending("runtime-unavailable"); }
				})();
			});
			if (!upgraded) await discard("protocol-error");
		} catch {
			await discard("authorization-unavailable");
			refuse();
		}
	});
	const sweeper = setInterval(sweep, 1000); sweeper.unref();
	server.on("close", () => { clearInterval(sweeper); wss.close(); });
	server.maxConnections = GATEWAY_LIMITS.connections * 4;
	return { server, async close() {
		clearInterval(sweeper);
		await Promise.all([...sessions.values()].map((s) => s.finish("gateway-stopped")));
		await Promise.all([...admitted.entries()].map(([connectionId, a]) => store.release({ intentId: a.intent.intentId, connectionId, reason: "gateway-stopped" })));
		admitted.clear();
		await new Promise((resolve) => server.close(resolve));
	} };
}
