/** Host self-description only: no consumer may use these facts to admit or refuse a job (#748). */
import { BACKEND_NAMES } from "./backends.mjs";
import { LIVE_JOB_ID_RE, publishedJobId } from "./live-jobs.mjs";
import { createHash } from "node:crypto";
import { imageRefProblem } from "./image-ref.mjs";
import { RUN_KINDS } from "./forges.mjs";

export const SANDBOXES_MAX = 32;
export const SANDBOX_READ_MS = 60_000;
export const CPU_RESERVE_WORDS = Object.freeze(["held", "no-parent", "unmanaged", "budget-unknown", "unreadable", "unset", "differs"]);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const decoded = (raw) => {
	if (typeof raw !== "string") return raw;
	if (raw.length > 32 * 1024) return null;
	try { return JSON.parse(raw); } catch { return null; }
};

/** Unknown and unreadable are null, never an invented empty inventory. */
export function parseSandboxes(raw) {
	const list = decoded(raw);
	if (!Array.isArray(list) || list.length > SANDBOXES_MAX) return null;
	// Corruption must not turn a nonempty inventory into a false claim that no workspace remains.
	if (list.some((r) => !object(r) || typeof r.id !== "string" || !LIVE_JOB_ID_RE.test(r.id) || !BACKEND_NAMES.includes(r.v) || !(r.until === null || integer(r.until)) || typeof r.pin !== "boolean")) return null;
	if (list.some((r) => (r.prepared !== undefined && typeof r.prepared !== "boolean") || (r.canOpen !== undefined && typeof r.canOpen !== "boolean") || (r.generation !== undefined && !/^[a-f0-9]{64}$/.test(r.generation)))) return null;
	if (list.some((r) => (r.image !== undefined && imageRefProblem(r.image)) || (r.kind !== undefined && !RUN_KINDS.includes(r.kind)))) return null;
	return list.map(({ id, v, until, pin, prepared, canOpen, generation, image, kind }) => ({ id, v, until, pin, ...(prepared !== undefined ? { prepared } : {}), ...(canOpen !== undefined ? { canOpen } : {}), ...(generation !== undefined ? { generation } : {}), ...(image !== undefined ? { image } : {}), ...(kind !== undefined ? { kind } : {}) }));
}

/** An opaque incarnation binds a confirmation to the workspace, without publishing its host path. */
export function sandboxManifestGeneration(m) {
	if (typeof m?.jobId !== "string" || typeof m?.image !== "string" || typeof m?.workspace !== "string" || typeof m?.createdAt !== "string") return null;
	return createHash("sha256").update(JSON.stringify([m.jobId, m.image, m.workspace, m.createdAt, m.backend ?? "local", m.baseSha ?? null, m.prepared?.requestDigest ?? null])).digest("hex");
}

export function parseBudgetFrom(raw) {
	const r = decoded(raw);
	if (!object(r)) return null;
	const out = {};
	for (const key of ["memMode", "cpuMode"]) {
		if (!["auto", "value", "off"].includes(r[key])) return null;
		out[key] = r[key];
	}
	for (const key of ["memTotalMiB", "memReserveMiB", "cpuTotalCenti", "cpuReserveCenti"]) {
		if (r[key] !== null && !integer(r[key])) return null;
		out[key] = r[key];
	}
	for (const key of ["memFloored", "cpuFloored"]) {
		if (typeof r[key] !== "boolean") return null;
		out[key] = r[key];
	}
	return out;
}

export function parseCpuReserve(raw) {
	const list = decoded(raw);
	if (!Array.isArray(list)) return null;
	const seen = new Set();
	return list.filter((r) => object(r) && BACKEND_NAMES.includes(r.venue) && CPU_RESERVE_WORDS.includes(r.status) && !seen.has(r.venue) && seen.add(r.venue)).map((r) => ({ venue: r.venue, status: r.status, wantCenti: integer(r.wantCenti) ? r.wantCenti : null, quotaCenti: integer(r.quotaCenti) ? r.quotaCenti : null }));
}

/** Cache filesystem work, not the heartbeat. The caller supplies the store's actual deadline rule. */
export function makeSandboxTelemetry({ list, deadline, retentionHours, canOpen = null, now = () => Date.now(), log = () => {} }) {
	let readAt = null;
	let unreadable = false;
	let cached = { sandboxes: "", sandboxesMore: "", sandboxRetentionHours: String(retentionHours) };
	return () => {
		const at = now();
		if (readAt !== null && at >= readAt && at - readAt < SANDBOX_READ_MS) return cached;
		readAt = at;
		try {
			const all = list().map((m) => {
				const id = publishedJobId(m.jobId);
				const venue = Object.hasOwn(m, "backend") ? m.backend : "local";
				if (!id || !BACKEND_NAMES.includes(venue)) return null;
				// Old manifests may lack these facts. Corrupt present facts make the inventory unknown, never invented.
				if ((m.image !== undefined && imageRefProblem(m.image)) || (m.kind !== undefined && !RUN_KINDS.includes(m.kind))) throw new Error("invalid sandbox image or kind");
				const d = deadline(m, retentionHours);
				const generation = sandboxManifestGeneration(m);
				return { id, v: venue, until: integer(d.until) ? d.until : null, pin: d.source === "pin", ...(m.origin === "prepared" ? { prepared: true } : {}), ...(generation ? { generation } : {}), ...(typeof canOpen === "function" ? { canOpen: canOpen(m) === true } : {}), ...(m.image !== undefined ? { image: m.image } : {}), ...(m.kind !== undefined ? { kind: m.kind } : {}), created: Date.parse(m.createdAt) || 0 };
			}).filter(Boolean).sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
			unreadable = false;
			cached = { sandboxes: JSON.stringify(all.slice(0, SANDBOXES_MAX).map(({ created, ...r }) => r)), sandboxesMore: String(Math.max(0, all.length - SANDBOXES_MAX)), sandboxRetentionHours: String(retentionHours) };
		} catch {
			// A failed read is absent telemetry, never a claim that the host has no retained workspaces.
			if (!unreadable) log("host_sandboxes_unreadable", { reason: "read-failed" });
			unreadable = true;
			cached = { sandboxes: "", sandboxesMore: "", sandboxRetentionHours: String(retentionHours) };
		}
		return cached;
	};
}
