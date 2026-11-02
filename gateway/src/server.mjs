import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { GATEWAY_ID_RE, GATEWAY_PENDING_MS, GATEWAY_GRANT_MS, gatewayHash, gatewayRandom } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { gatewayDimensions, GATEWAY_LIMITS } from "./terminal-protocol.mjs";
import { runGatewaySession } from "./session.mjs";
import { gatewayPage } from "./page.mjs";

const COOKIE = "pdg_browser";
const idOk = (s) => typeof s === "string" && GATEWAY_ID_RE.test(s) && Buffer.from(s, "base64url").toString("base64url") === s;
export function gatewayCookie(value, { secure = false } = {}) { return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil((GATEWAY_PENDING_MS + GATEWAY_GRANT_MS + GATEWAY_LIMITS.upgradeMs) / 1000)}${secure ? "; Secure" : ""}`; }
export function readGatewayCookie(header) {
	const values = String(header ?? "").split(";").map((s) => s.trim()).filter((s) => s.startsWith(`${COOKIE}=`)).map((s) => s.slice(COOKIE.length + 1));
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
			if (req.method === "GET" && /^\/s\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(gatewayPage({ consoleOrigin: config.consoleOrigin })); return; }
			const staticAssets = { "/static/gateway.js": [assets.script, "text/javascript"], "/static/terminal.js": [assets.terminalScript, "text/javascript"], "/static/gateway.css": [assets.css, "text/css"] };
			if (req.method === "GET" && Object.hasOwn(staticAssets, url.pathname)) { const [source, type] = staticAssets[url.pathname]; res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(source); return; }
			if (req.method !== "POST" || !["/api/bootstrap", "/api/connect"].includes(url.pathname)) { json(res, 404, { error: "not-found" }); return; }
			if (!originOk(req)) { json(res, 403, { error: "origin" }); return; }
			let m; try { m = await body(req); } catch { json(res, 400, { error: "body-invalid" }); return; }
			if (!m || typeof m !== "object" || Array.isArray(m) || !idOk(m.intentId)) { json(res, 400, { error: "intent-invalid" }); return; }
			const cookie = readGatewayCookie(req.headers.cookie);
			if (url.pathname === "/api/bootstrap") {
				if (Object.keys(m).sort().join() !== "handoff,intentId" || !idOk(m.handoff) || req.headers.cookie?.includes(`${COOKIE}=`) && !cookie) { json(res, 400, { error: "handoff-invalid" }); return; }
				const nonce = cookie ?? random();
				const result = await store.bindIntent({ intentId: m.intentId, handoff: m.handoff, browserHash: gatewayHash(nonce), gatewayOrigin: config.origin, host: config.host });
				if (!result.ok || !enrolled(result.intent)) { json(res, 409, { error: result.refused ?? "enrollment-changed" }); return; }
				res.setHeader("set-cookie", gatewayCookie(nonce, { secure: new URL(config.origin).protocol === "https:" }));
				json(res, 200, { authorizeUrl: `${config.consoleOrigin}/sandbox/gateway/authorize?intent=${m.intentId}` }); return;
			}
			if (Object.keys(m).sort().join() !== "cols,intentId,rows,width" || !Number.isInteger(m.width) || m.width < GATEWAY_LIMITS.minimumWidth || !gatewayDimensions(m.cols, m.rows)) { json(res, 400, { error: "dimensions" }); return; }
			if (!cookie) { json(res, 403, { error: "browser-missing" }); return; }
			sweep();
			if (reserved.size >= GATEWAY_LIMITS.connections) { json(res, 429, { error: "connection-limit" }); return; }
			const connectionId = random();
			if (reserved.has(connectionId)) { json(res, 503, { error: "connection-limit" }); return; }
			reserved.add(connectionId); reservation = connectionId;
			const intent = await store.readIntent(m.intentId);
			if (!enrolled(intent) || intent.browserHash !== gatewayHash(cookie)) { json(res, 409, { error: "intent-unavailable" }); return; }
			const result = await store.redeem({ intentId: m.intentId, browserHash: gatewayHash(cookie), connectionId });
			if (!result.ok) { json(res, 409, { error: result.refused }); return; }
			consumed = result.intent;
			const observation = await runtime.inspect(result.intent.target);
			if (!observation.ok) { json(res, 409, { error: ["runtime-environment", "sandbox-ended"].includes(observation.refused) ? observation.refused : "runtime-unavailable" }); return; }
			admitted.set(connectionId, { intent: result.intent, browserHash: gatewayHash(cookie), cols: m.cols, rows: m.rows, until: now() + GATEWAY_LIMITS.upgradeMs });
			reservation = null; consumed = null;
			json(res, 200, { connectionId, host: intent.target.host, id: intent.target.id, by: result.intent.actor.name, startedAt: result.intent.connectedAt, idleMinutes: config.idleMinutes, theme: intent.theme });
		} catch { log("gateway_request_failed"); if (!res.headersSent) json(res, 503, { error: "control-unavailable" }); else res.end(); }
		finally { if (reservation) { reserved.delete(reservation); if (consumed) await store.release({ intentId: consumed.intentId, connectionId: reservation, reason: "runtime-unavailable" }).catch(() => {}); } }
	});
	const wss = new WebSocketServer({ noServer: true, maxPayload: GATEWAY_LIMITS.frameBytes, perMessageDeflate: false, maxFragments: 128, maxBufferedChunks: 128 });
	server.on("upgrade", async (req, socket, head) => {
		const refuse = () => { if (!socket.destroyed) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); };
		let a, connectionId;
		const discard = async (reason) => {
			if (!a) return;
			admitted.delete(connectionId); reserved.delete(connectionId);
			await store.release({ intentId: a.intent.intentId, connectionId, reason }).catch(() => {});
		};
		try {
			sweep();
			const match = /^\/socket\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? "");
			const cookie = readGatewayCookie(req.headers.cookie);
			if (!hostOk(req) || !originOk(req) || !match || !cookie || req.headers["sec-websocket-protocol"]) { refuse(); return; }
			connectionId = match[1]; a = admitted.get(connectionId);
			if (!a || a.upgrading || a.browserHash !== gatewayHash(cookie)) { refuse(); return; }
			a.upgrading = true;
			const requestedAt = now();
			const authority = await store.renewAttachment({ intentId: a.intent.intentId, connectionId, browserHash: a.browserHash });
			if (!authority.ok || !Number.isFinite(authority.authRemainingMs) || authority.authRemainingMs <= 0 || authority.authRemainingMs > 5000 || now() - requestedAt >= authority.authRemainingMs) throw new Error("authorization-unavailable");
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
					if (opening) await audit("end", a.intent, connectionId, reason).catch(() => log("gateway_end_audit_failed"));
					sessions.delete(connectionId);
				};
				const earlyInput = () => { void endPending("protocol-error"); };
				ws.on("message", earlyInput);
				ws.once("close", () => { void endPending("disconnected"); });
				ws.once("error", () => { void endPending("disconnected"); });
				const expiresAt = Math.min(a.until, requestedAt + authority.authRemainingMs);
				const deadlineTimer = setTimeout(() => { void endPending("authorization-unavailable"); }, Math.max(0, expiresAt - now())); deadlineTimer.unref();
				sessions.set(connectionId, { finish: endPending });
				void (async () => {
					try {
						opening = true;
						try { await audit("opening", a.intent, connectionId); } catch { await endPending("audit-unavailable"); return; }
						if (cancelled) return;
						channel = await runtime.attach(a.intent.target, { cols: a.cols, rows: a.rows, signal: controller.signal });
						if (cancelled) { channel.detach(); return; }
						if (ws.readyState !== 1) { await endPending("disconnected"); return; }
						try { await audit("open", a.intent, connectionId); } catch { await endPending("audit-unavailable"); return; }
						const remaining = expiresAt - now();
						if (cancelled || remaining <= 0 || ws.readyState !== 1) { await endPending("authorization-unavailable"); return; }
						clearTimeout(deadlineTimer); admitted.delete(connectionId); ws.removeListener("message", earlyInput);
						const active = sessionFn({ ws, channel, store, intent: a.intent, connectionId, browserHash: a.browserHash, authRemainingMs: remaining, idleMinutes: config.idleMinutes, runtime, audit, now, onEnd: ({ auditFailed }) => { sessions.delete(connectionId); reserved.delete(connectionId); if (auditFailed) log("gateway_end_audit_failed"); } });
						handedOff = true; sessions.set(connectionId, active); ws.send(JSON.stringify({ type: "ready" }));
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
