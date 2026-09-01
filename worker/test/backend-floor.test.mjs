import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ASSERTED, DEFAULT_BACKEND, ENFORCED, backendRefusals, floorShortfall, parseBackendFloor, parseBackendList, unarmedFloor } from "../src/backends.mjs";
import { loadConfig } from "../src/config.mjs";
import { backendChecks, runDoctor } from "../src/doctor.mjs";

// PI_EGRESS=0 in the base env so these tests are about the FLOOR and not about the egress ladder, which
// has its own tests below. Every other variable is left unset on purpose: the defaults are the subject.
const base = () => ({ PI_EGRESS: "0" });

test("an unset PI_BACKENDS is the one name every existing deployment already runs", () => {
	// The whole point of the default: an operator who has never heard of this variable gets what they had.
	assert.deepEqual(parseBackendList(undefined), [DEFAULT_BACKEND]);
	assert.deepEqual(parseBackendList(""), [DEFAULT_BACKEND]);
	assert.deepEqual(parseBackendList("   "), [DEFAULT_BACKEND]);
	const c = loadConfig(base());
	assert.deepEqual(c.backends, ["local"]);
	assert.deepEqual(c.backendFloor, {});
	assert.equal(c.defaultBackend, "local");
});

test("PI_BACKENDS REFUSES an unknown name rather than dropping it", () => {
	// Dropping would leave an operator who misspelled their one entry with a silently empty set, and every
	// later refusal would then name the trigger rather than the typo.
	assert.throws(() => parseBackendList("nope"), /unknown backend "nope"/);
	assert.throws(() => parseBackendList("local,nope"), /unknown backend "nope"/);
	assert.throws(() => parseBackendList("Local"), /unknown backend "Local"/, "names are case-sensitive");
	assert.throws(() => loadConfig({ ...base(), PI_BACKENDS: "vapour" }), /unknown backend "vapour"/);
});

test("PI_BACKENDS dedupes and keeps order, because the first entry is the default", () => {
	assert.deepEqual(parseBackendList(" local , local "), ["local"]);
	assert.equal(loadConfig({ ...base(), PI_BACKENDS: "local" }).defaultBackend, "local");
});

test("PI_BACKEND_FLOOR parses property=word pairs", () => {
	assert.deepEqual(parseBackendFloor(undefined), {});
	assert.deepEqual(parseBackendFloor("egress=enforced, nonRoot=asserted"), { egress: ENFORCED, nonRoot: ASSERTED });
	// PI_EGRESS armed here, because a floor naming a gated property is refused when its switch is off --
	// which is its own test below.
	assert.deepEqual(loadConfig({ PI_EGRESS: "1", PI_BACKEND_FLOOR: "egress=enforced" }).backendFloor, { egress: ENFORCED });
});

test("PI_BACKEND_FLOOR refuses every malformed shape rather than reading it as empty", () => {
	// The strictness IS the feature. `shortfall` returning [] is indistinguishable from a satisfied floor,
	// so a floor this module cannot read must never become one it reads as asking for nothing. PI_EGRESS
	// refuses a third value for the same reason, and its comment says so in the same words.
	assert.throws(() => parseBackendFloor("egress"), /must be property=word/, "no separator");
	assert.throws(() => parseBackendFloor("=enforced"), /must be property=word/, "no property");
	assert.throws(() => parseBackendFloor("egres=enforced"), /unknown property "egres"/, "a typo'd KEY");
	assert.throws(() => parseBackendFloor("nonroot=enforced"), /unknown property "nonroot"/, "wrong case");
	assert.throws(() => parseBackendFloor("toString=enforced"), /unknown property/, "a prototype key");
	assert.throws(() => parseBackendFloor("egress=enfroced"), /must be one of/, "a typo'd WORD");
	assert.throws(() => parseBackendFloor("egress="), /must be one of/, "an empty word");
	assert.throws(() => parseBackendFloor("egress=ENFORCED"), /must be one of/, "words are case-sensitive too");
	// Named twice is an operator writing down two things deliberately; last-wins would silently pick one.
	assert.throws(() => parseBackendFloor("egress=enforced,egress=absent"), /names egress twice/);
});

test("a floor the deployment cannot meet REFUSES BOOT, naming backend and property", () => {
	// Not a warning, and not per job: a deployment whose configuration needs something its backends cannot
	// provide should learn it at boot, once, rather than at the first job that happens to want it.
	assert.throws(
		() => loadConfig({ ...base(), PI_BACKEND_FLOOR: "nonRoot=enforced" }),
		(err) => /PI_BACKEND_FLOOR is not met/.test(err.message) && /local: nonRoot is asserted/.test(err.message),
		"the refusal must name the backend, the property, what it has and what was wanted",
	);
});

test("a floor the deployment DOES meet boots, and asserted satisfies a floor asking for asserted", () => {
	assert.equal(loadConfig({ ...base(), PI_BACKEND_FLOOR: "nonRoot=asserted" }).backendFloor.nonRoot, ASSERTED);
	assert.equal(loadConfig({ PI_EGRESS: "1", PI_BACKEND_FLOOR: "egress=enforced,isolation=enforced" }).backends[0], "local");
});

// An UNKNOWN backend name declares every property `absent`, which makes it a perfectly good stand-in for a
// backend that provides nothing. That is what lets these rules be driven at all: `parseBackendList` accepts
// exactly one name today, so a rule reachable only through `loadConfig` could not be violated on purpose --
// and three of them survived a mutation pass for exactly that reason before the ladders moved into the leaf.
const NOTHING = "a-backend-that-provides-nothing";

test("the floor is checked against EVERY blessed backend, not only the default", () => {
	// A floor is a statement about where this deployment's jobs may run, and any blessed backend is
	// somewhere they may run. Checking only the default would let an operator bless a backend that fails
	// the floor and reach it from a trigger, which is the floor widened from the surface it bounds.
	assert.deepEqual(floorShortfall(["local"], { nonRoot: ENFORCED }), [{ backend: "local", property: "nonRoot", have: ASSERTED, want: ENFORCED }]);
	assert.deepEqual(floorShortfall([], { nonRoot: ENFORCED }), [], "no backends is no shortfall");
	assert.deepEqual(floorShortfall(["local"], {}), []);
	// TWO entries, with the failing one SECOND. Every array here used to hold at most one name, so slicing
	// the loop to `[0]` passed the whole suite and this test's own title was a claim it could not make.
	assert.deepEqual(floorShortfall(["local", NOTHING], { isolation: ENFORCED }), [{ backend: NOTHING, property: "isolation", have: "absent", want: ENFORCED }]);
	// And FIRST, so the fix cannot be "check the last one instead".
	assert.equal(floorShortfall([NOTHING, "local"], { isolation: ENFORCED }).length, 1);
});

test("PI_EGRESS armed against a backend that cannot do egress is refused", () => {
	// The ladder is implied rather than written by the operator: arming egress IS asking for egress,
	// whatever the floor says, so a backend declaring it absent would arm a control that cannot exist there
	// and report nothing. Deleting this entire ladder used to leave the suite green.
	const armed = backendRefusals({ backends: ["local", NOTHING], backendFloor: {}, egress: true });
	assert.equal(armed.length, 1);
	assert.match(armed[0], new RegExp(`PI_EGRESS is armed but ${NOTHING} declares egress absent`));
	// Unarmed, the same deployment has asked for nothing and is admissible on this axis.
	assert.deepEqual(backendRefusals({ backends: ["local", NOTHING], backendFloor: {}, egress: false }), []);
	// And the real deployment is not refused, which is the case that must never regress.
	assert.deepEqual(backendRefusals({ backends: ["local"], backendFloor: {}, egress: true }), []);
});

test("every refusal reason is reported, not only the first one found", () => {
	// `loadConfig` throws on the first, but the rules compute independently so a later slice can print all
	// of them. A ladder that silently stopped contributing would otherwise be invisible here.
	const both = backendRefusals({ backends: ["local", NOTHING], backendFloor: { isolation: ENFORCED }, egress: true });
	assert.equal(both.length, 2);
	assert.match(both[0], /PI_BACKEND_FLOOR is not met/);
	assert.match(both[1], /PI_EGRESS is armed/);
});

// Drive the REAL doctor and read its REAL output. An earlier version of this file asserted `c.warn === true`
// on the check OBJECT, which passed while every one of those lines rendered as a green tick -- `render`
// tests `c.ok` first, so `{ok: true, warn: true}` is a plain pass and its `fix` line is never printed. The
// promise this slice makes is about what an operator SEES, so the test has to look at that.
async function doctorText(env) {
	const buf = [];
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", ...env },
		{
			out: (s) => buf.push(s),
			spawn: () => {
				throw new Error("doctor must not need docker for the backend section");
			},
			probeValkey: async () => true,
			fileExists: () => true,
			nodeVersion: "22.19.0",
		},
	);
	return buf.join("");
}

test("doctor RENDERS asserted as a warning, naming who asserts it", async () => {
	// CONST-EGRESS-POLICY-IN-THE-ARGV: a control an operator BELIEVES in is worse than one they know is
	// missing. A green tick beside "credentialTransit is ASSERTED" is that belief, so the glyph is the
	// assertion here, not a field. `warn` still keeps the RUN green -- render only fails on !ok && !warn.
	const text = await doctorText(base());
	assert.match(text, /⚠ local: nonRoot is ASSERTED by the job image's USER directive/);
	assert.match(text, /⚠ local: credentialTransit is ASSERTED by the docker endpoint DOCKER_HOST resolves to/);
	assert.doesNotMatch(text, /✓ local: \w+ is ASSERTED/, "an asserted property must never render as a plain pass");
	// The fix line only prints for a non-ok check, so this also proves the operator gets the actionable half.
	assert.match(text, /→ not verifiable from here, so treat it as a claim rather than a control/);
	// An enforced property stays quiet, or the distinction would carry no information.
	assert.doesNotMatch(text, /local: isolation/);
});

test("doctor renders a gated property with its SWITCH, never the bare capability word", async () => {
	// `local` can enforce egress and a PI_EGRESS=0 deployment is not getting it. Two different sentences.
	const off = await doctorText({ PI_EGRESS: "0" });
	assert.match(off, /⚠ local: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it/);
	assert.match(off, /⚠ local: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off/);
	// Armed, it is the good case and stays quiet.
	assert.doesNotMatch(await doctorText({ PI_EGRESS: "1" }), /local: egress /);
});

test("doctor reports a malformed PI_EGRESS instead of guessing the good case", async () => {
	// An earlier draft caught the parse failure, set `armed = null`, and commented that "its own check
	// reports that". Nothing did: every gated property then fell through to the quiet enforced branch, so
	// doctor printed green on a deployment the worker refuses to boot.
	const text = await doctorText({ PI_EGRESS: "true" });
	assert.match(text, /✗ PI_EGRESS does not parse, so what this deployment actually gets cannot be determined/);
	assert.match(text, /⚠ local: egress depends on PI_EGRESS, which does not parse -- cannot say/);
	assert.doesNotMatch(text, /PI_BACKEND_FLOOR holds/);
});

test("doctor always says something about the floor, so a typo'd VARIABLE NAME cannot look like one that holds", async () => {
	// `PI_BACKENDS_FLOOR` is a plausible one-character-off spelling and nothing warns on an unknown PI_*
	// name, so silence would make a misnamed variable identical to a satisfied floor.
	assert.match(await doctorText(base()), /✓ PI_BACKEND_FLOOR is not set, so no minimum is required/);
	assert.match(await doctorText({ ...base(), PI_BACKENDS_FLOOR: "egress=enforced" }), /✓ PI_BACKEND_FLOOR is not set/);
});

test("doctor refuses to call an all-absent floor 'holding', because it bounds nothing", async () => {
	// `meets(have, absent)` is true for every value, so `egress=absent` is the one READABLE word that
	// reproduces the outcome `isDeclaration` refuses a typo for.
	const text = await doctorText({ ...base(), PI_BACKEND_FLOOR: "egress=absent,nonRoot=absent" });
	assert.match(text, /⚠ PI_BACKEND_FLOOR .* requires nothing: every entry asks for "absent"/);
	assert.doesNotMatch(text, /PI_BACKEND_FLOOR holds/);
});

test("doctor does not claim jobs run somewhere selection cannot send them", async () => {
	// Nothing selects a backend yet: start.mjs builds `local` unconditionally. "Jobs run on: local" would be
	// true only by the coincidence that local is the sole entry, so the line says so outright.
	assert.match(await doctorText(base()), /Jobs run on: local \(nothing selects between backends yet; every job runs on local\)/);
});

test("doctor FAILS on a backend configuration the worker would refuse to boot on", async () => {
	// Softening this to a warning would let doctor report green on a deployment that cannot start.
	const bad = backendChecks({ PI_BACKEND_FLOOR: "egres=enforced" });
	assert.equal(bad.length, 1);
	assert.equal(bad[0].ok, false);
	assert.equal(bad[0].warn, undefined, "a hard failure, so doctor's exit code moves");
	assert.match(await doctorText({ PI_BACKEND_FLOOR: "egres=enforced" }), /✗ backend configuration does not parse/);
});

test("doctor confirms a floor that holds, because that is a thing an operator ran the command to learn", async () => {
	assert.match(await doctorText({ PI_EGRESS: "1", PI_BACKEND_FLOOR: "egress=enforced" }), /✓ PI_BACKEND_FLOOR holds \(egress=enforced\)/);
});

test("a floor naming a switched-off control REFUSES BOOT, and doctor says which switch", async () => {
	// The sharpest defect this slice had. `local` declares `egress: enforced` whether or not PI_EGRESS is
	// armed, so a floor of `egress=enforced` passed `shortfall` and booted -- and doctor printed "this
	// deployment is not getting it" two lines above "PI_BACKEND_FLOOR holds". The operator had asked, in
	// writing, for the thing they were not getting.
	assert.throws(
		() => loadConfig({ PI_EGRESS: "0", PI_BACKEND_FLOOR: "egress=enforced" }),
		(err) => /switched off/.test(err.message) && /egress=enforced requires PI_EGRESS/.test(err.message),
	);
	assert.deepEqual(unarmedFloor({ egress: ENFORCED }, { PI_EGRESS: false }), [{ property: "egress", want: ENFORCED, armedBy: "PI_EGRESS" }]);
	assert.deepEqual(unarmedFloor({ egress: ENFORCED }, { PI_EGRESS: true }), [], "armed, it is met");
	// A floor asking for `absent` asks for nothing, so the switch is irrelevant to it.
	assert.deepEqual(unarmedFloor({ egress: "absent" }, { PI_EGRESS: false }), []);
	// An unknown switch position gets no credit, on this table's standing polarity.
	assert.deepEqual(unarmedFloor({ egress: ENFORCED }, {}).length, 1);
	assert.match(await doctorText({ PI_EGRESS: "0", PI_BACKEND_FLOOR: "egress=enforced" }), /✗ PI_BACKEND_FLOOR asks for egress=enforced, which PI_EGRESS has switched off/);
});

test("PI_BACKENDS always includes the backend that actually runs jobs", () => {
	// `start.mjs` builds `local` unconditionally, so every job runs there whatever this list says. A set
	// excluding it would make two statements false at once: the deployment would be told its jobs run
	// somewhere they do not, and the floor -- checked against this list -- would skip the backend actually
	// running them. The refusal cannot be reached through the parser while `local` is the only name (an
	// unknown name is rejected first), so what is pinned here is the INVARIANT it protects, which stays
	// meaningful when a second backend arrives.
	for (const raw of [undefined, "", "   ", "local", " local , local "]) {
		assert.ok(parseBackendList(raw).includes(DEFAULT_BACKEND), `${JSON.stringify(raw)} must still include ${DEFAULT_BACKEND}`);
	}
	// And the guard is present rather than merely intended, so removing it fails here rather than silently.
	const src = readFileSync(new URL("../src/backends.mjs", import.meta.url), "utf8");
	assert.match(src, /PI_BACKENDS must include .* until a backend can be selected per job/);
});

test("arming egress on the real deployment still boots", () => {
	// The case that must never regress while the ladders above are tightened.
	assert.equal(loadConfig({ PI_EGRESS: "1" }).egress, true);
	assert.deepEqual(floorShortfall(["local"], { egress: ASSERTED }), [], "local clears the implied floor");
});
