import * as nodeFs from "node:fs";
import { join } from "node:path";

/**
 * The runner's pre-check of a portfolio job's plan (issue #505): at exit, before the exit line, a read-only look at
 * `/outbox/priorities.json` that logs what the HOST is likely to say about it, so an operator reading the job's log sees
 * a malformed plan without opening the audit file. It decides NOTHING: the host collects and judges the file after the
 * container exits (worker/src/outbox-plan.mjs), the exit code and the exit line never depend on it, and every fault in
 * here is swallowed. A pre-check that could change the exit would let a plan file turn a completed paid job into a
 * retry.
 *
 * The shape check is VENDORED from the worker's `parsePlan` (worker/src/priorities.mjs), the part that needs no
 * envelope: the image cannot import `worker/`, and the image carries no allocation module on purpose (the open question
 * of #505: the host decides). `worker/test/plan-check-bolt.test.mjs` runs both over one corpus and requires the same
 * verdict, so the copy cannot drift silently. Change both in one commit.
 *
 * Logs enum tokens only (`plan_precheck { outcome, reason, field, rule }`), never a byte of the file: the plan is agent
 * text, and its `reason` fields are free text.
 */

export const PLAN_VERSION = 1;
export const WEIGHT_MAX = 1000;
export const REASON_MAX = 200;
export const PLAN_MAX_BYTES = 16 * 1024;
export const DEFAULT_MAX_PLAN_DAYS = 14;
export const OTHER = "_other";
export const PLAN_FIELDS = Object.freeze(["body", "plan", "version", "basis", "validUntil", "projects", "projects.id", "projects.weight", "projects.reason", "projects.repos", "projects.repos.ref", "projects.repos.weight"]);
export const PLAN_RULES = Object.freeze(["json", "too-large", "shape", "unknown-key", "missing", "type", "range", "newer", "format", "duplicate", "unknown-id", "control-char", "too-long", "past", "too-far", "missing-project", "missing-repo", "unknown-ref"]);

/** The plan file and the snapshot, where the worker's mounts put them. */
export const OUTBOX_DIR = "/outbox";
export const PLAN_FILE = "priorities.json";
export const SNAPSHOT_PATH = "/job/portfolio.json";

const PLAN_KEYS = new Set(["version", "basis", "validUntil", "projects"]);
const PROJECT_KEYS = new Set(["id", "weight", "reason", "repos"]);
const REPO_KEYS = new Set(["ref", "weight"]);
const BASIS_RE = /^[0-9a-f]{16}$/;
const REF_RE = /^[0-9a-f]{8}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const REASON_REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
// The project id rule (worker/src/project-id.mjs), restated for the same reason as the rest.
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LIST_MAX = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PLAN_DAYS = 366;
const MAX_DATE_MS = 8.64e15;

const refuse = (field, rule) => ({ ok: false, reason: "plan-invalid", field, rule });
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const unknownKey = (o, allowed) => Object.keys(o).some((k) => !allowed.has(k));
const isWeight = (v) => Number.isInteger(v) && v >= 0 && v <= WEIGHT_MAX;

/**
 * The structural verdict on a plan's TEXT: `{ ok: true }` or `{ ok: false, reason: "plan-invalid", field, rule }`, the
 * first refusal in the order `parsePlan` finds it. `now` (ms) and `maxPlanDays` are parsePlan's.
 */
export function checkPlanShape(text, { now, maxPlanDays = DEFAULT_MAX_PLAN_DAYS } = {}) {
	if (typeof text !== "string") return refuse("body", "type");
	if (Buffer.byteLength(text, "utf8") > PLAN_MAX_BYTES) return refuse("body", "too-large");
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return refuse("body", "json");
	}
	if (!isPlainObject(raw)) return refuse("plan", "shape");
	if (unknownKey(raw, PLAN_KEYS)) return refuse("plan", "unknown-key");
	if (raw.version === undefined) return refuse("version", "missing");
	if (!Number.isInteger(raw.version) || raw.version < 1) return refuse("version", "type");
	if (raw.version > PLAN_VERSION) return refuse("version", "newer");
	if (!("basis" in raw)) return refuse("basis", "missing");
	if (raw.basis !== null && (typeof raw.basis !== "string" || !BASIS_RE.test(raw.basis))) return refuse("basis", "format");
	if (!Number.isFinite(now) || !Number.isInteger(maxPlanDays) || maxPlanDays < 1 || maxPlanDays > MAX_PLAN_DAYS) return { ok: false, reason: "plan-precheck-unjudged", field: null, rule: null };
	const limitMs = now + maxPlanDays * DAY_MS;
	if (Math.abs(now) > MAX_DATE_MS || Math.abs(limitMs) > MAX_DATE_MS) return { ok: false, reason: "plan-precheck-unjudged", field: null, rule: null };
	if (raw.validUntil !== undefined) {
		if (typeof raw.validUntil !== "string" || !INSTANT_RE.test(raw.validUntil)) return refuse("validUntil", "format");
		const ms = Date.parse(raw.validUntil);
		if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== raw.validUntil.slice(0, 19)) return refuse("validUntil", "format");
		if (ms <= now) return refuse("validUntil", "past");
		if (ms > limitMs) return refuse("validUntil", "too-far");
	}
	if (!Array.isArray(raw.projects)) return refuse("projects", raw.projects === undefined ? "missing" : "type");
	if (raw.projects.length > LIST_MAX) return refuse("projects", "too-long");
	const seen = new Set();
	for (const entry of raw.projects) {
		if (!isPlainObject(entry)) return refuse("projects", "shape");
		if (unknownKey(entry, PROJECT_KEYS)) return refuse("projects", "unknown-key");
		if (entry.id === undefined) return refuse("projects.id", "missing");
		if (entry.id !== OTHER && !(typeof entry.id === "string" && PROJECT_ID_RE.test(entry.id))) return refuse("projects.id", "format");
		if (seen.has(entry.id)) return refuse("projects.id", "duplicate");
		seen.add(entry.id);
		if (entry.weight === undefined) return refuse("projects.weight", "missing");
		if (!Number.isInteger(entry.weight)) return refuse("projects.weight", "type");
		if (!isWeight(entry.weight)) return refuse("projects.weight", "range");
		if (entry.reason !== undefined) {
			if (typeof entry.reason !== "string" || entry.reason.trim() === "") return refuse("projects.reason", "type");
			if (REASON_REFUSED.test(entry.reason)) return refuse("projects.reason", "control-char");
			if ([...entry.reason].length > REASON_MAX) return refuse("projects.reason", "too-long");
		}
		if (entry.repos !== undefined) {
			const repos = entry.repos;
			if (!Array.isArray(repos) || repos.length === 0) return refuse("projects.repos", "type");
			if (entry.id === OTHER) return refuse("projects.repos", "unknown-ref");
			if (repos.length > LIST_MAX) return refuse("projects.repos", "too-long");
			const refs = new Set();
			for (const repo of repos) {
				if (!isPlainObject(repo)) return refuse("projects.repos", "shape");
				if (unknownKey(repo, REPO_KEYS)) return refuse("projects.repos", "unknown-key");
				if (repo.ref === undefined) return refuse("projects.repos.ref", "missing");
				if (typeof repo.ref !== "string" || !REF_RE.test(repo.ref)) return refuse("projects.repos.ref", "format");
				if (refs.has(repo.ref)) return refuse("projects.repos.ref", "duplicate");
				refs.add(repo.ref);
				if (repo.weight === undefined) return refuse("projects.repos.weight", "missing");
				if (!Number.isInteger(repo.weight)) return refuse("projects.repos.weight", "type");
				if (!isWeight(repo.weight)) return refuse("projects.repos.weight", "range");
			}
		}
	}
	return { ok: true };
}

/** The snapshot's `envelope.maxPlanDays`, or the default: a small bounded read that never throws. */
function snapshotMaxPlanDays(fs, path) {
	try {
		const st = fs.lstatSync(path);
		if (!st.isFile() || st.size > 64 * 1024) return DEFAULT_MAX_PLAN_DAYS;
		const days = JSON.parse(fs.readFileSync(path, "utf8"))?.envelope?.maxPlanDays;
		return Number.isInteger(days) && days >= 1 && days <= MAX_PLAN_DAYS ? days : DEFAULT_MAX_PLAN_DAYS;
	} catch {
		return DEFAULT_MAX_PLAN_DAYS;
	}
}

/** Read the plan under the host's rules (lstat, regular, size, O_NOFOLLOW|O_NONBLOCK, fstat, a bounded read), or a token. */
function readPlan(fs, path) {
	const pre = fs.lstatSync(path);
	if (pre.size > PLAN_MAX_BYTES) return { reason: "plan-oversize" };
	if (!pre.isFile()) return { reason: "plan-not-regular-file" };
	const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants ?? nodeFs.constants;
	let fd;
	try {
		fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (error) {
		return { reason: error?.code === "ELOOP" || error?.code === "ENXIO" ? "plan-not-regular-file" : "plan-unreadable" };
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return { reason: "plan-not-regular-file" };
		if (st.size > PLAN_MAX_BYTES) return { reason: "plan-oversize" };
		const buf = Buffer.alloc(PLAN_MAX_BYTES + 1);
		let got = 0;
		for (;;) {
			const n = fs.readSync(fd, buf, got, buf.length - got, null);
			if (n === 0) break;
			got += n;
			if (got > PLAN_MAX_BYTES) return { reason: "plan-oversize" };
		}
		return { text: buf.subarray(0, got).toString("utf8") };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {}
	}
}

/**
 * The pre-check, called by run-job.mjs right before the exit line and its result DISCARDED. Returns undefined, always,
 * and never throws. Logs nothing when there is neither a plan file nor a snapshot (no portfolio job); otherwise one
 * `plan_precheck` line. A portfolio job (it has the snapshot) that wrote no plan file logs `plan-absent` (issue #507),
 * so the job's own log says it wrote nothing. The pre-check runs on any exit, but the host records `plan-absent` only
 * for a job that completed: on any other exit it collects nothing, so the line is a hint, like every other here.
 */
export function precheckAtExit({ outboxDir = OUTBOX_DIR, snapshotPath = SNAPSHOT_PATH, fs = nodeFs, log = () => {}, now = () => Date.now() } = {}) {
	try {
		const path = join(outboxDir, PLAN_FILE);
		// The snapshot is read first: whether "no file" is worth a line depends on it.
		let snapshot = false;
		try {
			snapshot = fs.lstatSync(snapshotPath).isFile();
		} catch {}
		try {
			fs.lstatSync(path);
		} catch (error) {
			if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
				if (snapshot) log("plan_precheck", { outcome: "refused", reason: "plan-absent" });
				return undefined;
			}
			log("plan_precheck", { outcome: "refused", reason: "plan-unreadable" });
			return undefined;
		}
		// No snapshot: this is no portfolio job, and the host will refuse the file as such.
		if (!snapshot) {
			log("plan_precheck", { outcome: "refused", reason: "plan-not-portfolio" });
			return undefined;
		}
		const read = readPlan(fs, path);
		if (read.reason) {
			log("plan_precheck", { outcome: "refused", reason: read.reason });
			return undefined;
		}
		let root;
		try {
			root = JSON.parse(read.text);
		} catch {
			root = undefined;
		}
		if (!isPlainObject(root)) {
			log("plan_precheck", { outcome: "refused", reason: "plan-parse-error" });
			return undefined;
		}
		const verdict = checkPlanShape(read.text, { now: now(), maxPlanDays: snapshotMaxPlanDays(fs, snapshotPath) });
		if (verdict.ok) log("plan_precheck", { outcome: "ok", reason: null });
		else log("plan_precheck", { outcome: "refused", reason: verdict.reason, field: verdict.field, rule: verdict.rule });
	} catch {
		// Whatever happened, the exit line is written and the exit code stands.
		try {
			log("plan_precheck", { outcome: "unjudged", reason: null });
		} catch {}
	}
	return undefined;
}
