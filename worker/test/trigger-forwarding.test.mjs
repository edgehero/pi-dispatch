import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSchedules } from "../src/schedules.mjs";
import { parseTriggers } from "../src/triggers.mjs";

/**
 * The cron twin of receiver/test/trigger-forwarding.test.mjs (issue #502). A cron trigger's run fields
 * reach the job through one hand-written literal in schedules.mjs, and a key the loader emits that the
 * literal forgets runs every scheduled job without it. The key set is DERIVED from the loader's own
 * normalized output, so a field added to normalizeCron without a carrier here fails this test.
 */

// Normalized cron run keys that are not job data. Empty today, and kept as a named set so an exclusion
// has to be written down with its reason rather than slipped into a filter expression.
const ROUTING_ONLY = new Set([]);

const BASE = {
	folder: "/proj",
	github: true,
	packages: false,
	image: "pi-job:2",
	resume: false,
	skillsDir: "/srv/skills",
	secrets: { STRIPE_KEY: "op://ci/stripe/api-key" },
	secretsProfile: "ci",
	backend: "local",
	excludeTools: ["bash"],
	provider: "openai",
	model: "gpt-5.4",
	maxTurns: 9,
	// #502 part 3. Lists the main model, which the loader requires when one trigger names all three.
	models: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"],
};
// flow+task and command are exclusive, so the twin loads each.
const VARIANTS = { flow: { flow: "tidy", task: "run the tidy pass" }, command: { command: "wf run" } };

function load(variant) {
	const json = JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", ...BASE, ...variant } }] });
	const [normalized] = parseTriggers(json, "/t.json");
	const [schedule] = loadSchedules({ triggersFile: "/t.json" }, { readFileSync: () => json, existsSync: () => true });
	return { normalized, data: schedule.data };
}

const execKeys = (normalized) => Object.keys(normalized.run).filter((k) => !ROUTING_ONLY.has(k) && normalized.run[k] !== undefined);

test("the maximal cron fixture sets every field this test protects", () => {
	const keys = new Set(Object.values(VARIANTS).flatMap((v) => execKeys(load(v).normalized)));
	for (const k of ["kind", ...Object.keys(BASE), "flow", "task", "command"]) assert.ok(keys.has(k), `normalized cron run lacks ${k}`);
});

for (const [name, variant] of Object.entries(VARIANTS)) {
	test(`cron (${name}): every execution key the loader emits reaches the schedule's job data`, () => {
		const { normalized, data } = load(variant);
		for (const k of execKeys(normalized)) {
			assert.deepEqual(data[k], normalized.run[k], `schedules.mjs dropped run.${k} on the way to the job`);
		}
		for (const k of ["provider", "model", "maxTurns", "models"]) assert.equal(k in data.trigger, false, `${k} leaked into trigger`);
	});
}

test("cron absent stays absent: no model named serializes to job data with no provider, model or maxTurns", () => {
	const json = JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "t" } }] });
	const [schedule] = loadSchedules({ triggersFile: "/t.json" }, { readFileSync: () => json, existsSync: () => true });
	const wire = JSON.parse(JSON.stringify(schedule.data));
	for (const k of ["provider", "model", "maxTurns", "models"]) assert.equal(k in wire, false, k);
});
