import assert from "node:assert/strict";
import { test } from "node:test";
import { runJob } from "../src/processor.mjs";
import { parseTriggers, refusesLocalWorkspace } from "../src/triggers.mjs";

const parse = (entries) => parseTriggers(JSON.stringify({ triggers: entries }), "/x/triggers.json");
const cron = (run = {}, on = {}) => ({ on: { type: "cron", id: "n", pattern: "0 3 * * *", ...on }, run: { kind: "local", folder: "/p", flow: "f", task: "t", ...run } });
const label = (run = {}) => ({ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "f", ...run } });

test("an unflagged trigger normalizes byte-identically -- no backend key at all", () => {
	// The whole non-negotiable of #227: a deployment that never heard of this field is unaffected. A key
	// present-but-undefined would still change `JSON.stringify` of the job data, so absence is the assertion.
	const [t] = parse([cron()]);
	assert.equal("backend" in t.run, false);
	assert.equal("backend" in parse([label()])[0].run, false);
});

test("run.backend is carried through on every normalizer that accepts it", () => {
	assert.equal(parse([cron({ backend: "local" })])[0].run.backend, "local");
	for (const entry of [
		label({ backend: "local" }),
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "f", backend: "local" } },
		{ on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "f", backend: "local" } },
		{ on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "f", backend: "local" } },
	]) {
		assert.equal(parse([entry])[0].run.backend, "local", JSON.stringify(entry.on.type));
	}
});

test("run.backend is a NAME, and the loader refuses anything that is not one", () => {
	// `validateSecretsProfile` is the template end to end: a trigger SELECTS among what the deployment
	// blessed and never configures a posture. `run.network` was rejected outright, and this must not become
	// a way back to it.
	assert.throws(() => parse([cron({ backend: "" })]), /must be a non-empty string/);
	assert.throws(() => parse([cron({ backend: 3 })]), /must be a non-empty string/);
	assert.throws(() => parse([cron({ backend: { name: "local" } })]), /must be a non-empty string/);
	assert.throws(() => parse([cron({ backend: "a,b" })]), /letters, digits, dot, dash and underscore only/);
	assert.throws(() => parse([cron({ backend: "a b" })]), /letters, digits, dot, dash and underscore only/);
});

test("a name this BUILD does not know is refused at load, and the message says where blessing is decided", () => {
	// The split `secretsProfile` already draws: the charset is the file's business, the deployment's own
	// list is not, so the refusal points at PI_BACKENDS rather than pretending to have checked it.
	assert.throws(
		() => parse([cron({ backend: "vapour" })]),
		(err) => /is not a backend this build knows \(known: local\)/.test(err.message) && /PI_BACKENDS/.test(err.message),
	);
});

test("a NEAR-MISS spelling is refused, because a dropped venue is a destructive absence", () => {
	// `run.imgae` gives you the default image and a job that ran, which is harmless. A misspelled `backend`
	// gives you the DEFAULT VENUE and a job that ran -- byte-identical in the record, the panel and the log
	// to one that correctly chose -- while the file reads as though it chose. That is `waitFor`'s class.
	for (const key of ["Backend", "backEnd", "back_end", "back-end", "backends", "BACKEND"]) {
		assert.throws(() => parse([cron({ [key]: "local" })]), /is not a field -- did you mean run\.backend\?/, key);
	}
	// On `on` every spelling is wrong INCLUDING the correct one: a venue is a property of the run, so
	// `on.backend` would be dropped exactly as silently as a typo.
	assert.throws(() => parse([cron({}, { backend: "local" })]), /on\.backend is not a field/);
	// And the exact spelling on `run` is of course the field itself.
	assert.equal(parse([cron({ backend: "local" })])[0].run.backend, "local");
});

test("the processor REFUSES a job naming an unblessed backend, pre-spend and returned not thrown", async () => {
	// CONST-RETRY-INFRA-ONLY: a determinate policy refusal RETURNS so the queue does not retry it. A throw
	// would pay to re-decide an answer that can never change.
	const calls = [];
	const res = await runJob(
		{ id: "j1", kind: "local", folder: "/p", flow: "f", task: "t", backend: "vapour", provider: "anthropic", model: "m" },
		{
			blessedBackends: ["local"],
			comment: async (_j, text) => calls.push(text),
			log: () => {},
			imagePreflight: async () => {
				throw new Error("must refuse BEFORE anything spawns");
			},
			mintToken: async () => {
				throw new Error("must refuse BEFORE a credential is minted");
			},
			prepareWorkspace: async () => {
				throw new Error("must refuse BEFORE a clone");
			},
			runContainer: async () => {
				throw new Error("must never start a container");
			},
		},
	);
	assert.equal(res.outcome, "policy");
	assert.equal(res.reason, "backend-unblessed");
	assert.equal(res.budgetReserved, false, "refused before the reservation, so no cap slot is burned");
	assert.equal(res.exitCode, null);
	assert.equal(res.provider, "anthropic", "a pre-container refusal still attributes what it was dispatched for");
	assert.match(calls[0], /does not bless/);
});

test("a job naming a BLESSED backend passes the gate", async () => {
	// The gate must not become a refusal for everyone. Driven to the next gate rather than to completion.
	let reached = false;
	await runJob(
		{ id: "j2", kind: "local", folder: "/p", flow: "f", task: "t", backend: "local" },
		{
			blessedBackends: ["local"],
			comment: async () => {},
			log: () => {},
			imagePreflight: async () => {
				reached = true;
				throw new Error("stop here");
			},
		},
	).catch(() => {});
	assert.equal(reached, true, "a blessed backend reaches the image preflight");
});

test("a job naming NO backend never consults the blessed list", async () => {
	// Which is what makes the fail-closed default safe: an unflagged job is unaffected by it entirely.
	let reached = false;
	await runJob(
		{ id: "j3", kind: "local", folder: "/p", flow: "f", task: "t" },
		{
			blessedBackends: [],
			comment: async () => {},
			log: () => {},
			imagePreflight: async () => {
				reached = true;
				throw new Error("stop here");
			},
		},
	).catch(() => {});
	assert.equal(reached, true, "no backend named means no gate");
});

test("the processor's default blesses only the backend every deployment already runs", async () => {
	// An admit-everything default would let a wiring that forgot the key run a job anywhere it was told to.
	// The default is the narrowest useful one rather than the widest, which is `resolveSecrets`' direction.
	const res = await runJob(
		{ id: "j4", kind: "local", folder: "/p", flow: "f", task: "t", backend: "vapour" },
		{ comment: async () => {}, log: () => {} },
	);
	assert.equal(res.reason, "backend-unblessed");
});


test("a REMOTE venue is refused on a trigger bound to a folder on this machine", () => {
	// Driven against a synthetic entry because the real table holds one backend and it is local, so the
	// branch is unreachable through `parseTriggers` -- and a mutation pass duly deleted it with the whole
	// suite staying green. DES-WORKER-ON-HOST finding (2) is physics: the operator's own folder must be
	// bind-mounted as /workspace and edited in place, and there is no volume to hide behind.
	assert.equal(refusesLocalWorkspace({ remote: true }, true), true, "remote venue, folder-bound trigger");
	assert.equal(refusesLocalWorkspace({ remote: true }, false), false, "a forge job clones, so it may run remotely");
	assert.equal(refusesLocalWorkspace({ remote: false }, true), false, "the local venue is where a folder already is");
	// FAIL-CLOSED on a missing key: `remote` is not a member of the closed PROPERTIES list, so an entry that
	// omitted it would read as local under `=== true` and be admitted onto a folder-bound trigger. Physics
	// must not be defeated by an absent field.
	assert.equal(refusesLocalWorkspace({}, true), true, "an entry that declares nothing gets no benefit of the doubt");
	assert.equal(refusesLocalWorkspace(undefined, true), true);
});

test("the processor's default blesses local, so a correctly-authored trigger still runs", async () => {
	// The other half of the default, and the half a mutation pass showed was unpinned: the old test ruled
	// out the WIDEST default (admit-everything) and never the NARROWEST. A default of `[]` also refuses
	// "vapour", so it passed -- while refusing `backend: "local"` on any wiring that forgot the key, which
	// is every correctly-authored trigger refused pre-spend on every delivery, forever.
	let reached = false;
	await runJob(
		{ id: "j5", kind: "local", folder: "/p", flow: "f", task: "t", backend: "local" },
		{
			comment: async () => {},
			log: () => {},
			imagePreflight: async () => {
				reached = true;
				throw new Error("stop here");
			},
		},
	).catch(() => {});
	assert.equal(reached, true, "the default must admit the backend every deployment already runs");
});
