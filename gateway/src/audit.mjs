import * as nodeFs from "node:fs";
import { join } from "node:path";
import { makeConsoleAudit, consoleAuditDriver } from "@edgehero/pi-dispatch/console-audit";
import { cleanGatewayTarget, GATEWAY_ID_RE } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";

/** A bounded metadata journal accounts for attachment endings after a process crash, without capturing bytes. */
export function makeGatewayAudit({ logsDir, fs = nodeFs, now = Date.now, audit = makeConsoleAudit({ logsDir, fs, now }), pid = process.pid, pidAlive = (id) => { try { process.kill(id, 0); return true; } catch (error) { return error.code !== "ESRCH"; } } } = {}) {
	const dir = join(logsDir, "sandbox-gateway-active");
	const actorOk = (a) => a?.role === "operator" && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(a.name ?? "") && /^[a-f0-9]{12}$/.test(a.session ?? "");
	const append = (kind, m, reason) => audit.append({ actor: m.actor, action: "write", kind, target: `${m.target.host}/${m.target.containerId}`, outcome: "ok", ...(reason ? { reason } : {}), ...(kind.startsWith("sandbox-watch-") && ["opening", "start", "end"].includes(kind.slice("sandbox-watch-".length)) ? { driver: consoleAuditDriver(m.driverActor ?? m.driver) } : {}) });
	function secureDir() {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const st = fs.lstatSync(dir);
		if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077 || Number.isInteger(process.geteuid?.()) && st.uid !== process.geteuid()) throw new Error("gateway audit journal is not private");
	}
	return {
		recover() {
			secureDir();
			const names = fs.readdirSync(dir);
			if (names.length > 32) throw new Error("gateway audit journal exceeds its bound");
			for (const name of names) {
				if (!/^[A-Za-z0-9_-]{43}\.json$/.test(name)) throw new Error("gateway audit journal holds an unknown entry");
				const path = join(dir, name), st = fs.lstatSync(path);
				if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 || st.mode & 0o077) throw new Error("gateway audit journal cannot be recovered safely");
				let m; try { m = JSON.parse(fs.readFileSync(path, "utf8")); } catch { throw new Error("gateway audit journal cannot be read"); }
				if (!actorOk(m.actor) || !cleanGatewayTarget(m.target) || !Number.isSafeInteger(m.pid) || m.pid < 1 || ![undefined, "drive", "watch"].includes(m.mode) || (m.mode === "watch" ? !consoleAuditDriver(m.driver) : m.driver !== undefined)) throw new Error("gateway audit journal identity is invalid");
				// Another gateway may share this host's audit directory. Only a dead owner is
				// recovery evidence; a reused/live PID conservatively holds the bounded journal.
				if (pidAlive(m.pid)) continue;
				append(m.mode === "watch" ? "sandbox-watch-end" : "sandbox-browser-end", m, "gateway-stopped");
				fs.unlinkSync(path);
			}
		},
		async record(kind, intent, connectionId, reason) {
			if (!GATEWAY_ID_RE.test(connectionId ?? "") || !actorOk(intent?.actor) || !cleanGatewayTarget(intent?.target)) throw new Error("gateway audit identity is invalid");
			const watch = intent.kind === "watch", driver = watch ? consoleAuditDriver(intent.driverActor) : null;
			if (watch && !driver) throw new Error("gateway watch audit driver identity is invalid");
			secureDir();
			const path = join(dir, `${connectionId}.json`);
			if (kind === "opening") {
				if (fs.readdirSync(dir).length >= 32) throw new Error("gateway audit journal is full");
				fs.writeFileSync(path, JSON.stringify({ actor: intent.actor, target: cleanGatewayTarget(intent.target), pid, mode: watch ? "watch" : "drive", ...(driver ? { driver } : {}) }), { flag: "wx", mode: 0o600 });
				append(watch ? "sandbox-watch-opening" : "sandbox-browser-opening", intent);
			} else if (kind === "open") {
				append(watch ? "sandbox-watch-start" : "sandbox-browser-open", intent);
			} else if (["policy-intent", "policy", "remove-intent", "remove"].includes(kind)) {
				append(kind.startsWith("policy") ? "sandbox-watch-policy" : "sandbox-watch-remove", intent, reason);
			} else {
				append(watch ? "sandbox-watch-end" : "sandbox-browser-end", intent, reason);
				try { fs.unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
			}
		},
	};
}
