import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	CREDENTIAL_STOP_BEFORE_MS,
	CREDENTIALS_DIR_SUFFIX,
	CREDENTIALS_FILE,
	FORGE_RENEW_BEFORE_MS,
	makeCredentialRefresher,
	makeCredentialsDir,
	removeCredentialsDir,
	SUBSCRIPTION_RENEW_BEFORE_MS,
	writeCredentialDrop,
} from "../src/credential-refresh.mjs";
import { CONTAINER_CREDENTIALS_DIR } from "../src/container-spec.mjs";
import { forgeSpec } from "../src/forges.mjs";
import { BESIDE_JOB_DIR } from "../src/recovery-queue.mjs";
import { CREDENTIAL_DIR, FORGE_TOKEN_VARS, parseCredentialDrop } from "../../image/runner/src/credential-refresh.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A refresher on a fake clock that records what it writes. */
function harness({ forge = { expiresAt: HOUR }, subscriptions = [], mint, extend } = {}) {
	const h = { t: 0, writes: [], stops: [], logs: [], mints: 0, extends: 0 };
	h.r = makeCredentialRefresher({
		dir: "/unused",
		forge: forge ? { ...forge, mint: mint ?? (async () => (h.mints++, { token: `ghs_renewed_${h.mints}`, expiresAt: h.t + HOUR })) } : null,
		subscriptions,
		extend: extend ?? (async (snap, { deadlineAt }) => (h.extends++, { ...snap, generation: snap.generation + 1, deadlineAt, expiresAt: deadlineAt + 6 * HOUR, env: { ANTHROPIC_OAUTH_TOKEN: `sk-ant-oat-renewed-${h.extends}` } })),
		now: () => h.t,
		onExpired: (kind) => h.stops.push(kind),
		log: (event, fields) => h.logs.push({ event, ...fields }),
		write: (payload) => {
			if (h.failWrites) throw new Error("disk full");
			h.writes.push(payload);
		},
	});
	h.at = async (t) => {
		h.t = t;
		await h.r.check();
	};
	return h;
}

const SNAP = { provider: "anthropic", connectionId: "claude-main", adapter: "pi-anthropic-oauth@0.3.6", generation: 3, expiresAt: 4 * HOUR, deadlineAt: 30 * MIN, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-first" } };

test("the two folders' paths agree: the worker mounts where the runner reads, and a crashed job's folder is swept", () => {
	assert.equal(CONTAINER_CREDENTIALS_DIR, CREDENTIAL_DIR);
	assert.deepEqual([...FORGE_TOKEN_VARS].sort(), [...forgeSpec("github").tokenVars].sort(), "the runner writes the GitHub token under the names the worker hands it in");
	assert.ok(BESIDE_JOB_DIR.includes(CREDENTIALS_DIR_SUFFIX));
});

test("a GitHub App token is renewed 15 minutes before it expires, and again for each new hour", async () => {
	const h = harness();
	await h.at(HOUR - FORGE_RENEW_BEFORE_MS - 1);
	assert.equal(h.writes.length, 0);
	await h.at(HOUR - FORGE_RENEW_BEFORE_MS);
	assert.equal(h.writes.length, 1);
	assert.deepEqual(h.writes[0], { v: 1, seq: 1, forge: { token: "ghs_renewed_1" }, subscriptions: [] });
	await h.at(HOUR + 20 * MIN);
	assert.equal(h.writes.length, 1, "the new token lives to 1h45, so nothing is due before 1h30");
	await h.at(2 * HOUR - FORGE_RENEW_BEFORE_MS + 45 * MIN);
	assert.equal(h.writes.length, 2);
	assert.equal(h.writes[1].seq, 2);
	assert.deepEqual(h.stops, []);
	assert.ok(!JSON.stringify(h.logs).includes("ghs_"), "no value in any line");
});

test("a subscription snapshot is extended 10 minutes before its deadline, for the same connection, and dropped with its token", async () => {
	const h = harness({ forge: null, subscriptions: [SNAP] });
	await h.at(30 * MIN - SUBSCRIPTION_RENEW_BEFORE_MS);
	assert.equal(h.writes.length, 1);
	const [row] = h.writes[0].subscriptions;
	assert.deepEqual(row, { provider: "anthropic", connectionId: "claude-main", generation: 4, expiresAt: 50 * MIN + 6 * HOUR, deadlineAt: 50 * MIN, token: "sk-ant-oat-renewed-1" });
	// What the worker writes is exactly what the runner accepts.
	assert.deepEqual(parseCredentialDrop(JSON.stringify(h.writes[0])).subscriptions, [row]);
});

test("a renewal that fails is tried again, and the job is stopped only when the credential the runner holds is about to run out", async () => {
	let ok = false;
	const h = harness({ mint: async () => (ok ? { token: "ghs_late", expiresAt: 2 * HOUR } : Promise.reject(new Error("GitHub is down"))) });
	await h.at(HOUR - FORGE_RENEW_BEFORE_MS);
	await h.at(HOUR - 5 * MIN);
	assert.deepEqual(h.stops, []);
	assert.equal(h.logs.filter((l) => l.event === "credential_renew_failed").length, 2);
	await h.at(HOUR - CREDENTIAL_STOP_BEFORE_MS);
	assert.deepEqual(h.stops, ["forge-token"]);
	await h.at(HOUR);
	assert.deepEqual(h.stops, ["forge-token"], "once");
	// The same failure, then a recovery in time: no stop.
	const later = harness({ mint: async () => (ok ? { token: "ghs_late", expiresAt: 2 * HOUR } : Promise.reject(new Error("down"))) });
	await later.at(HOUR - 10 * MIN);
	ok = true;
	await later.at(HOUR - 4 * MIN);
	assert.deepEqual(later.stops, []);
	assert.equal(later.writes.length, 1);
});

test("a renewal whose drop could not be written is written again, and the stop judges what the runner holds", async () => {
	const h = harness({ forge: null, subscriptions: [SNAP] });
	h.failWrites = true;
	await h.at(25 * MIN);
	assert.equal(h.writes.length, 0);
	await h.at(27 * MIN);
	assert.deepEqual(h.stops, [], "the runner's deadline is still 30 minutes");
	await h.at(28 * MIN);
	assert.deepEqual(h.stops, ["subscription"], "renewed here, never delivered: the runner's credential runs out");
	const ok = harness({ forge: null, subscriptions: [SNAP] });
	ok.failWrites = true;
	await ok.at(21 * MIN);
	ok.failWrites = false;
	await ok.at(22 * MIN);
	assert.equal(ok.writes.length, 1, "the next look writes it");
	await ok.at(29 * MIN);
	assert.deepEqual(ok.stops, []);
});

test("an extension for another connection, or one that does not move the deadline, is not taken", async () => {
	for (const bad of [{ connectionId: "other" }, { deadlineAt: 30 * MIN }, { env: {} }]) {
		const h = harness({ forge: null, subscriptions: [SNAP], extend: async (snap, { deadlineAt }) => ({ ...snap, generation: 4, deadlineAt, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-x" }, ...bad }) });
		await h.at(25 * MIN);
		assert.equal(h.writes.length, 0, JSON.stringify(bad));
	}
});

test("the drop folder is made fresh and owner-only beside the job directory, written atomically, and removed", () => {
	const root = tempDir("cred-folder-");
	const jobDir = join(root, "job-abc");
	fs.mkdirSync(jobDir);
	fs.mkdirSync(`${jobDir}${CREDENTIALS_DIR_SUFFIX}`);
	fs.writeFileSync(join(`${jobDir}${CREDENTIALS_DIR_SUFFIX}`, "stale.json"), "old");
	const dir = makeCredentialsDir(jobDir);
	assert.equal(dir, `${jobDir}${CREDENTIALS_DIR_SUFFIX}`);
	assert.deepEqual(fs.readdirSync(dir), [], "a crashed attempt's leftover is gone");
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	writeCredentialDrop(dir, { v: 1, seq: 1, forge: { token: "ghs_abcdefgh" }, subscriptions: [] });
	assert.deepEqual(fs.readdirSync(dir), [CREDENTIALS_FILE], "no temp file left");
	assert.equal(fs.statSync(join(dir, CREDENTIALS_FILE)).mode & 0o777, 0o444);
	writeCredentialDrop(dir, { v: 1, seq: 2, forge: { token: "ghs_abcdefgh2" }, subscriptions: [] });
	assert.equal(JSON.parse(fs.readFileSync(join(dir, CREDENTIALS_FILE), "utf8")).seq, 2, "a later drop replaces it");
	removeCredentialsDir(dir);
	assert.equal(fs.existsSync(dir), false);
	assert.equal(makeCredentialsDir(""), null);
});
