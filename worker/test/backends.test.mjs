import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ABSENT, ASSERTED, BACKENDS, BACKEND_NAMES, DEFAULT_BACKEND, ENFORCED, PROPERTIES, PROPERTY_NAMES, backendFor, declarationOf, isDeclaration, isProperty, meets, shortfall } from "../src/backends.mjs";

test("the table is a LEAF -- it imports nothing", () => {
	// `forges.mjs`'s reason, and it is why doctor and the config loader can read a declaration without
	// pulling the Docker implementation into their graph. A single import here would drag `docker-run.mjs`
	// into the receiver's bundle the day a backend is selected at enqueue.
	const src = readFileSync(new URL("../src/backends.mjs", import.meta.url), "utf8");
	assert.equal(/^import\s/m.test(src), false, "backends.mjs must import nothing");
	assert.equal(/require\(/.test(src), false);
});

test("every backend declares EVERY property -- omission is not a pass", () => {
	// The polarity `dev.pi-dispatch.capabilities` already uses for images: a thing that declares nothing
	// gets no benefit of the doubt. A backend that simply omitted `egress` would otherwise read as fine.
	for (const name of BACKEND_NAMES) {
		const declared = Object.keys(BACKENDS[name].declares);
		assert.deepEqual(declared.slice().sort(), PROPERTY_NAMES.slice().sort(), `${name} must declare exactly the closed list`);
		for (const property of PROPERTY_NAMES) {
			assert.ok(isDeclaration(BACKENDS[name].declares[property]), `${name}.${property} must be one of the three words`);
		}
	}
});

test("the closed list covers the guarantees a backend could otherwise silently drop", () => {
	// The closed-list rule ("a backend that omits one is not admitted for it") is only sound if the list is
	// COMPLETE. These five were missing from the first draft, and each is a way to declare everything else
	// enforced and still have no boundary: reuse one container across issue authors, mount the docker
	// socket, put every job on one segment, have no way to stop a runaway, or ship the token off-host.
	for (const property of ["ephemeral", "mountSet", "jobToJobIsolation", "abortable", "credentialTransit"]) {
		assert.ok(PROPERTY_NAMES.includes(property), `the list must name ${property}`);
	}
});

test("every property carries the question an operator is actually asking", () => {
	// A bare property name is the un-actionable amber this project's design rejects elsewhere: an operator
	// reading "egress: absent" needs to know what that costs them without opening the specs.
	for (const property of PROPERTY_NAMES) {
		assert.ok(PROPERTIES[property].question.length > 20, `${property} needs a real question`);
		assert.ok("armedBy" in PROPERTIES[property], `${property} must say whether a switch gates it`);
	}
});

test("a deployment-armed property says so, because a capability is not a posture", () => {
	// The defect this replaced: `egress: enforced` read as a flat statement about what a running job gets,
	// which is the "shall" CONST-EGRESS-POLICY-IN-THE-ARGV's revision row refuses to write -- it names and
	// rejects `CONST-EGRESS-DENIED-BY-DEFAULT` precisely because "an operator can set PI_EGRESS=0". With
	// PI_EGRESS=0 the --network flag is absent and the job sits on docker's default bridge, so a bare word
	// would be a believed-in control. The capability is still `enforced`; the switch is named beside it.
	assert.equal(PROPERTIES.egress.armedBy, "PI_EGRESS");
	assert.equal(PROPERTIES.jobToJobIsolation.armedBy, "PI_EGRESS");
	assert.equal(BACKENDS.local.declares.egress, ENFORCED, "local CAN build it, in its own argv");
	// And the unconditional ones must not claim a switch, or the distinction stops meaning anything.
	for (const property of ["isolation", "imagePinning", "readOnlyJobInputs", "ephemeral", "mountSet"]) {
		assert.equal(PROPERTIES[property].armedBy, null, `${property} is not gated by a switch`);
	}
});

test("credentialTransit is ASSERTED, because DOCKER_HOST can redirect every spawn", () => {
	// The second honest one. Every spawn is `docker` with the worker's environment inherited, so
	// DOCKER_HOST=tcp://... or a docker context sends the connection to another machine with the provider
	// key and the per-job forge token riding as `-e NAME=VALUE`. DOCKER_HOST appears nowhere in this repo:
	// no code sets it, no check refuses it, no test reads it back -- so `enforced` would be an overclaim by
	// this module's own definition of the word.
	assert.equal(BACKENDS.local.declares.credentialTransit, ASSERTED);
	// And secretsCustody keeps ENFORCED only because it no longer asks the network question.
	assert.equal(BACKENDS.local.declares.secretsCustody, ENFORCED);
	assert.equal(/network/i.test(PROPERTIES.secretsCustody.question), false, "that clause belongs to credentialTransit");
});

test("declarationOf joins a word to what qualifies it, so a consumer cannot print it bare", () => {
	// `declares` is a bare {property: word} map and `armedBy` lives on PROPERTIES, so a consumer that
	// printed the word alone would reintroduce the capability-read-as-posture defect this table was fixed
	// for. One definition of the join rather than each consumer remembering to write it.
	assert.deepEqual(declarationOf("local", "egress"), {
		property: "egress",
		word: ENFORCED,
		armedBy: "PI_EGRESS",
		question: PROPERTIES.egress.question,
	});
	assert.equal(declarationOf("local", "isolation").armedBy, null);
	assert.equal(declarationOf("nope", "egress"), undefined);
	assert.equal(declarationOf("local", "egres"), undefined);
	assert.equal(declarationOf("local", "toString"), undefined);
});

test("local declares non-root as ASSERTED, because it is the image's and not the argv's", () => {
	// The honest one, and the reason the vocabulary has three words rather than a boolean. SECURITY.md says
	// it in terms: "Non-root is not in that argv." An operator-built image can run as root and nothing in
	// this repo refuses it, which is `OQ-012`. Declaring it `enforced` would be the believed-in control
	// CONST-EGRESS-POLICY-IN-THE-ARGV warns displaces the bound that is really holding.
	assert.equal(BACKENDS.local.declares.nonRoot, ASSERTED);
	assert.equal(BACKENDS.local.declares.isolation, ENFORCED, "the flags in the argv ARE ours");
});

test("the table is deeply FROZEN, so a bundle holder cannot rewrite what doctor is told", () => {
	// `makeLocalBackend` hands `BACKENDS.local.declares` out by reference. Unfrozen, one assignment would
	// change the answer every later reader gets -- the boot refusal, doctor, the receiver -- process-wide
	// and invisibly, while the source still read `enforced`. Modules are strict mode, so this throws.
	assert.ok(Object.isFrozen(BACKENDS));
	assert.ok(Object.isFrozen(BACKENDS.local));
	assert.ok(Object.isFrozen(BACKENDS.local.declares));
	// PROPERTIES is the sharper one: `isProperty` reads it, and `isProperty` is the whole of `shortfall`'s
	// validation gate. Unfrozen, one assignment deletes a property (every floor naming it then throws
	// "unknown property"), adds one, or nulls out an `armedBy` so the capability word prints bare again --
	// undoing this table's central fix from inside.
	assert.ok(Object.isFrozen(PROPERTIES), "PROPERTIES must be frozen");
	assert.ok(Object.isFrozen(PROPERTY_NAMES), "and the name list it is derived from");
	for (const p of PROPERTY_NAMES) assert.ok(Object.isFrozen(PROPERTIES[p]), `${p} entry must be frozen`);
	assert.throws(() => {
		PROPERTIES.egress.armedBy = null;
	}, TypeError);
	assert.throws(() => {
		delete PROPERTIES.jobToJobIsolation;
	}, TypeError);
	assert.throws(() => {
		PROPERTIES.pwned = { question: "x", armedBy: null };
	}, TypeError);
	assert.equal(PROPERTIES.egress.armedBy, "PI_EGRESS", "and the switch survived");
	assert.throws(() => {
		BACKENDS.local.declares.egress = ABSENT;
	}, TypeError);
	assert.throws(() => {
		BACKENDS.evil = { declares: {} };
	}, TypeError);
	assert.equal(BACKENDS.local.declares.egress, ENFORCED, "and the value survived the attempts");
});

test("the default backend is what every existing deployment is already running", () => {
	assert.equal(DEFAULT_BACKEND, "local");
	assert.equal(backendFor(undefined), BACKENDS.local, "no name means the default, not a failure");
	assert.equal(backendFor("nope"), undefined, "an unknown name is the CALLER's to refuse");
});

test("backendFor does not hand back a prototype member for a name nobody declared", () => {
	// The header tells callers to write `if (!backendFor(name)) refuse()`. A bare index walks the prototype
	// chain, so `PI_BACKEND=constructor` would return a truthy function and walk straight past that guard.
	for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
		assert.equal(backendFor(name), undefined, `${name} is not a backend`);
	}
});

test("strength orders enforced > asserted > absent", () => {
	assert.ok(meets(ENFORCED, ASSERTED) && meets(ENFORCED, ABSENT) && meets(ASSERTED, ABSENT));
	assert.ok(!meets(ASSERTED, ENFORCED) && !meets(ABSENT, ASSERTED));
	assert.ok(meets(ENFORCED, ENFORCED) && meets(ASSERTED, ASSERTED));
});

test("an undeclared or gibberish HAVE ranks bottom", () => {
	assert.equal(meets(undefined, ASSERTED), false);
	assert.equal(meets("enfroced", ASSERTED), false, "a backend declaring gibberish gets no credit");
	assert.equal(meets("toString", ASSERTED), false, "and no prototype key is a declaration");
});

test("meets is permissive about a gibberish WANT, which is why shortfall validates instead", () => {
	// Pinned as a TRAP rather than as a feature: `meets` cannot reject it, because "met by everything" is
	// also the right answer for a floor genuinely asking for `absent`. The guard belongs one level up.
	assert.equal(meets(ABSENT, "enfroced"), true);
	assert.equal(isDeclaration("enfroced"), false);
	assert.equal(isDeclaration(""), false);
	assert.equal(isDeclaration(undefined), false);
	assert.equal(isDeclaration("constructor"), false, "prototype keys are not declarations");
	assert.ok([ENFORCED, ASSERTED, ABSENT].every(isDeclaration));
});

test("isProperty rejects a prototype key as a property name", () => {
	assert.ok(PROPERTY_NAMES.every(isProperty));
	for (const n of ["toString", "constructor", "__proto__", "egres", ""]) assert.equal(isProperty(n), false, n);
});

test("shortfall NAMES what is missing rather than returning a boolean", () => {
	// A refusal reading only "this backend does not meet the floor" sends an operator to read a table. The
	// whole value of three words is that the failing one can be printed.
	assert.deepEqual(shortfall("local", { egress: ENFORCED, isolation: ENFORCED }), [], "local meets what it enforces");
	assert.deepEqual(shortfall("local", { nonRoot: ENFORCED }), [{ property: "nonRoot", have: ASSERTED, want: ENFORCED }]);
	assert.deepEqual(shortfall("local", { nonRoot: ASSERTED }), [], "and asserted satisfies a floor asking for asserted");
});

test("shortfall REFUSES a floor with a misspelled property name", () => {
	// The same silent-open hazard as a misspelled word, arriving through the key. Iterating the closed list
	// would never visit `egres` at all, so the operator gets `[]` back -- indistinguishable from a satisfied
	// floor -- and believes they have a bound they do not have.
	for (const bad of [{ egres: ENFORCED }, { nonroot: ENFORCED }, { networkNamespace: ENFORCED }, { toString: ENFORCED }]) {
		assert.throws(() => shortfall("local", bad), /unknown property/, JSON.stringify(bad));
	}
});

test("shortfall REFUSES a floor whose value is not one of the three words", () => {
	// Including every falsy shape, which an earlier `if (!need) continue` skipped in silence: an unset env
	// var arrives as "", a JSON null arrives as null, and both would have read as "asks for nothing".
	for (const bad of ["enfroced", "", null, 0, false, undefined, "ENFORCED", "constructor", ["enforced"], { toString: () => "enforced" }, new String("enforced")]) {
		assert.throws(() => shortfall("local", { nonRoot: bad }), /must be one of/, JSON.stringify(bad));
	}
});

test("an UNKNOWN backend falls short of everything asked of it", () => {
	// Not an empty shortfall. A name nobody declared must never read as conformant.
	const missing = shortfall("does-not-exist", { egress: ENFORCED, isolation: ASSERTED });
	assert.deepEqual(
		missing.map((m) => m.property).sort(),
		["egress", "isolation"],
	);
	assert.ok(missing.every((m) => m.have === ABSENT));
});

test("a floor asking for nothing is met by anything, including an unknown backend", () => {
	// Deliberate: an empty floor is the deployment that has not opted in, and it must not refuse. `null` is
	// the same case rather than a TypeError -- it is how an absent floor arrives from JSON.
	assert.deepEqual(shortfall("local", {}), []);
	assert.deepEqual(shortfall("does-not-exist", {}), []);
	assert.deepEqual(shortfall("local", null), []);
	assert.deepEqual(shortfall("local"), []);
});
