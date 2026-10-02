import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ABSENT, HOST_ROUTE_LAN, HOST_ROUTE_LOOPBACK, HOST_ROUTE_OTHER_MACHINE, HOST_ROUTE_OWN_ADDRESS, HOST_ROUTE_REACHABLE, HOST_ROUTE_REFUTED, HOST_ROUTE_UNMEASURED, HOST_ROUTE_WORKS, HOST_ROUTES, PROXY_LOCAL_ADDRESSES, hostRouteFor, isPerMachineHost, isProxyLocalHost, ASSERTED, BACKENDS, BACKEND_NAMES, DAEMON_APPLIES_BOUNDS, DEFAULT_BACKEND, DOCKER_ENDPOINT_LOCAL, ENFORCED, OBSERVATION_FIX, OBSERVATIONS, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_BOUNDS_DELEGATED, PODMAN_SERVICE_LOCAL, RUNTIME_ADDS_NO_MOUNTS, PROPERTIES, PROPERTY_NAMES, UNATTRIBUTED_BACKEND, backendFor, declarationOf, effectiveWord, isDeclaration, isProperty, meets, parseBackendList, shortfall } from "../src/backends.mjs";

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

test("every backend declares whether it is REMOTE, because a missing key would read as local", () => {
	// `remote` is not a member of the closed PROPERTIES list, so nothing else forces it to exist -- and
	// `validateBackend` refuses a remote venue on a folder-bound trigger, a refusal that file calls physics.
	// An entry omitting the key would defeat that refusal with an absent field, which is the fail-open
	// direction this module's own rule forbids. The check there is `!== false`, so both halves fail together.
	for (const name of BACKEND_NAMES) {
		assert.equal(typeof BACKENDS[name].remote, "boolean", `${name} must declare remote as a boolean`);
	}
	assert.equal(BACKENDS.local.remote, false);
});

test("an artifact that names no venue was produced on a LOCAL one, which the table still holds (#277)", () => {
	// An artifact recorded before venue attribution predates every entry but `local`, so whatever reads such an
	// artifact as this venue needs it to stay a real, non-remote entry.
	assert.equal(UNATTRIBUTED_BACKEND, "local");
	assert.ok(Object.hasOwn(BACKENDS, UNATTRIBUTED_BACKEND));
	assert.equal(BACKENDS[UNATTRIBUTED_BACKEND].remote, false);
});

test("an unattributed artifact stays LOCAL where local is not even blessed, and never follows the default (#354)", () => {
	// Once `PI_BACKENDS` may omit `local`, a host's default can be another venue. Absence is a fact about the past (it
	// predates venue attribution, when `local` was all there was), so it stays `local` and such a host cold-starts that
	// key once as `venue-changed` (`session-store.test.mjs` drives that with a non-local default). Deriving it from the
	// parsed list would resume a Docker-written transcript under another runtime on a stamp never written.
	const known = ["local", "podman"];
	assert.equal(parseBackendList("podman", { known })[0], "podman", "the default follows the list");
	assert.equal(UNATTRIBUTED_BACKEND, "local", "the past does not");
	const store = readFileSync(new URL("../src/session-store.mjs", import.meta.url), "utf8");
	assert.match(store, /return err\?\.code === "ENOENT" \? UNATTRIBUTED_BACKEND : null;/, "the store reads absence as the constant, not as its defaultBackend");
});

test("every backend name fits the charset a venue stamp relies on (#277)", () => {
	// A recorded venue is only unambiguous while every name this build knows stays inside the trigger
	// charset: a sentinel or separator written outside it can then never be mistaken for a venue.
	for (const name of BACKEND_NAMES) assert.match(name, /^[A-Za-z0-9._-]+$/, name);
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

test("every ASSERTED property names who asserts it, and no other property claims an asserter", () => {
	// The closed-list rule applied one level down: an asserted word with no source is not actionable, and a
	// source on an enforced word would be a claim about something this worker builds itself.
	for (const name of BACKEND_NAMES) {
		for (const property of PROPERTY_NAMES) {
			const d = declarationOf(name, property);
			if (BACKENDS[name].declares[property] === ASSERTED) {
				assert.ok(typeof d.assertedBy === "string" && d.assertedBy.length > 20, `${name}.${property} must name its asserter`);
			} else {
				assert.equal(d.assertedBy, null, `${name}.${property} is not asserted, so it names no asserter`);
			}
		}
	}
});

test("credentialTransit is ENFORCED only while the docker endpoint is OBSERVED on this host (#278)", () => {
	// It was ASSERTED while nothing in the repo looked where the docker CLI sends containers. The worker now
	// asks the CLI, so the word is earned -- but only while the answer is "this host": a redirected CLI takes
	// the provider key and the per-job forge token along as `-e NAME=VALUE`, and the word must not survive that.
	assert.equal(BACKENDS.local.declares.credentialTransit, ENFORCED);
	assert.equal(BACKENDS.local.observedBy.credentialTransit, DOCKER_ENDPOINT_LOCAL);
	assert.equal(BACKENDS.local.asserts.credentialTransit, undefined, "no asserter: the worker observes it");
	assert.equal(effectiveWord("local", "credentialTransit", { [DOCKER_ENDPOINT_LOCAL]: true }), ENFORCED);
	for (const seen of [{ [DOCKER_ENDPOINT_LOCAL]: false }, {}, undefined, { [DOCKER_ENDPOINT_LOCAL]: "true" }]) {
		assert.equal(effectiveWord("local", "credentialTransit", seen), ASSERTED, `degrades for ${JSON.stringify(seen)}`);
	}
	// Properties with no observation keep their declared word whatever is observed.
	assert.equal(effectiveWord("local", "egress", {}), ENFORCED);
	assert.equal(effectiveWord("local", "nonRoot", { [DOCKER_ENDPOINT_LOCAL]: true }), ASSERTED);
	assert.equal(effectiveWord("nope", "egress", {}), undefined);
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
		assertedBy: null,
		observedBy: null,
	});
	assert.equal(declarationOf("local", "credentialTransit").observedBy, DOCKER_ENDPOINT_LOCAL, "and an observation-gated word says so");
	assert.equal(declarationOf("local", "isolation").armedBy, null);
	// An asserted word carries WHO asserts it. "not us" without "them" leaves an operator nothing to check,
	// which is why doctor can honestly say it names the asserter.
	assert.match(declarationOf("local", "nonRoot").assertedBy, /USER directive/);
	// Issue #341: and who asserts it where the argv supplies the uid, with the uid-1001 exception named.
	// Issue #481: the whole sentence, pinned: it once ran "other than 1001 the worker's own" with no separator, which a
	// fragment match cannot see, and doctor prints it verbatim before ", not enforced by it".
	assert.equal(declarationOf("local", "nonRoot").assertedBy, "the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`");
	assert.equal(declarationOf("local", "credentialTransit").assertedBy, null, "enforced, so no asserter");
	assert.equal(declarationOf("local", "isolation").assertedBy, null, "meaningless for an enforced word");
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
	// #278: the maps beside it too. `asserts` is what doctor prints beside a word and `observedBy` decides
	// whether the word holds; `asserts` had been left mutable.
	assert.ok(Object.isFrozen(BACKENDS.local.asserts));
	assert.ok(Object.isFrozen(BACKENDS.local.observedBy));
	assert.throws(() => {
		BACKENDS.local.observedBy.credentialTransit = "nothing";
	}, TypeError);
	assert.throws(() => {
		BACKENDS.local.asserts.nonRoot = "trust me";
	}, TypeError);
	assert.ok(Object.isFrozen(OBSERVATIONS));
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

test("every observedBy names a property and an observation from the closed list (#278)", () => {
	for (const name of BACKEND_NAMES) {
		for (const [property, observation] of Object.entries(BACKENDS[name].observedBy)) {
			assert.ok(isProperty(property), `${name}.observedBy.${property} is a property`);
			assert.ok(Object.hasOwn(OBSERVATIONS, observation), `${name}.observedBy.${property} names a known observation`);
		}
	}
});

test("isolation and mountSet are ENFORCED only while the runtime is OBSERVED providing them (#345)", () => {
	assert.deepEqual({ ...BACKENDS.local.observedBy }, { isolation: DAEMON_APPLIES_BOUNDS, mountSet: RUNTIME_ADDS_NO_MOUNTS, credentialTransit: DOCKER_ENDPOINT_LOCAL });
	assert.deepEqual(Object.keys(OBSERVATIONS), [DOCKER_ENDPOINT_LOCAL, DAEMON_APPLIES_BOUNDS, RUNTIME_ADDS_NO_MOUNTS, PODMAN_BOUNDS_DELEGATED, PODMAN_ADDS_NO_MOUNTS, PODMAN_SERVICE_LOCAL]);
	assert.deepEqual(Object.keys(OBSERVATION_FIX), Object.keys(OBSERVATIONS), "every observation has its own remedy, and no remedy names an observation that does not exist");
	assert.ok(Object.isFrozen(OBSERVATION_FIX));
	for (const [property, observation] of [["isolation", DAEMON_APPLIES_BOUNDS], ["mountSet", RUNTIME_ADDS_NO_MOUNTS]]) {
		assert.equal(BACKENDS.local.declares[property], ENFORCED, property);
		assert.equal(effectiveWord("local", property, { [observation]: true }), ENFORCED, property);
		for (const seen of [{ [observation]: false }, { [observation]: null }, {}, { [DOCKER_ENDPOINT_LOCAL]: true }]) {
			assert.equal(effectiveWord("local", property, seen), ASSERTED, `${property} degrades for ${JSON.stringify(seen)}`);
		}
	}
});

test("the podman venue declares every word ENFORCED, three of them only while podman's OWN observations hold (#354)", () => {
	// Pinned word by word, so a word moved without its reason fails here beside the entry's comments. Each rests on a
	// measurement on rootless Podman 5.8.1 (DES-PODMAN-NATIVE-ROOTLESS-BACKEND); `nonRoot` is the one that differs from
	// local, because this venue's argv always supplies the worker's own non-zero uid.
	assert.equal(PODMAN_BACKEND, "podman");
	assert.ok(BACKEND_NAMES.includes(PODMAN_BACKEND));
	const entry = BACKENDS[PODMAN_BACKEND];
	assert.equal(entry.remote, false, "a remote service is refused, never declared");
	for (const property of PROPERTY_NAMES) assert.equal(entry.declares[property], ENFORCED, property);
	assert.deepEqual({ ...entry.asserts }, {}, "nothing asserted, so nothing names an asserter");
	assert.deepEqual({ ...entry.observedBy }, { isolation: PODMAN_BOUNDS_DELEGATED, mountSet: PODMAN_ADDS_NO_MOUNTS, credentialTransit: PODMAN_SERVICE_LOCAL });
	// Podman's observations are its own: local's read `docker info` and the docker CLI's endpoint, which say nothing about
	// the podman CLI's rootless store, and podman's say nothing about a Docker daemon.
	for (const observation of Object.values(entry.observedBy)) assert.equal(Object.values(BACKENDS.local.observedBy).includes(observation), false, observation);
	const all = { [PODMAN_BOUNDS_DELEGATED]: true, [PODMAN_ADDS_NO_MOUNTS]: true, [PODMAN_SERVICE_LOCAL]: true };
	for (const [property, observation] of Object.entries(entry.observedBy)) {
		assert.equal(effectiveWord(PODMAN_BACKEND, property, all), ENFORCED, property);
		for (const seen of [{ ...all, [observation]: false }, { ...all, [observation]: null }, {}, { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: true, [RUNTIME_ADDS_NO_MOUNTS]: true }]) {
			assert.equal(effectiveWord(PODMAN_BACKEND, property, seen), ASSERTED, `${property} degrades for ${JSON.stringify(seen)}`);
		}
	}
	assert.equal(effectiveWord(PODMAN_BACKEND, "nonRoot", {}), ENFORCED, "not observation-gated");
	assert.deepEqual(shortfall(PODMAN_BACKEND, { nonRoot: ENFORCED }), [], "the floor local cannot meet, podman can");
	for (const observation of [PODMAN_BOUNDS_DELEGATED, PODMAN_ADDS_NO_MOUNTS, PODMAN_SERVICE_LOCAL]) {
		assert.ok(OBSERVATIONS[observation].length > 40, observation);
		assert.match(OBSERVATION_FIX[observation], /or lower that entry to `asserted`/, observation);
	}
	assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.declares) && Object.isFrozen(entry.asserts) && Object.isFrozen(entry.observedBy));
	assert.deepEqual(parseBackendList("podman"), ["podman"], "PI_BACKENDS=podman alone is a deployment through the real table");
});

// Issue #503: the measured routes from the egress proxy to a model server on the host.
const LAN_HOST = ["192.168.5.15"];
const PASTA = { backend: "podman", rootless: true, helper: "pasta", version: "5.8.1", hostAddresses: LAN_HOST };
const SLIRP = { backend: "podman", rootless: true, helper: "slirp4netns", version: "4.9.3", hostAddresses: LAN_HOST };
const ROOTFUL = { backend: "podman", rootless: false, version: "5.8.1", hostAddresses: LAN_HOST };
const ENGINE = { backend: "docker", desktop: false, version: "29.1.3", hostAddresses: LAN_HOST };
const DESKTOP = { backend: "docker", desktop: true, os: "darwin", version: "27.4.0" };
const RUNTIMES = [DESKTOP, ENGINE, ROOTFUL, SLIRP, PASTA];
// Issue #530: the Mac's own LAN address in #503's acceptance run.
const DESKTOP_HOST = ["192.168.68.54"];

test("HOST_ROUTES is frozen to the row, and is no part of the declaration vocabulary (#503)", () => {
	assert.ok(Object.isFrozen(HOST_ROUTES) && Object.isFrozen(PROXY_LOCAL_ADDRESSES));
	for (const [venue, rows] of Object.entries(HOST_ROUTES)) {
		assert.ok(Object.isFrozen(rows), venue);
		for (const row of rows) {
			assert.ok(Object.isFrozen(row) && Object.isFrozen(row.when), `${venue} ${row.name}`);
			assert.deepEqual(Object.keys(row).sort(), ["measured", "name", "needs", "status", "when"], `${venue} ${row.name}`);
			const informational = row.name === HOST_ROUTE_OTHER_MACHINE;
			assert.ok(informational ? row.status === HOST_ROUTE_REACHABLE : [HOST_ROUTE_WORKS, HOST_ROUTE_REFUTED].includes(row.status), `${venue} ${row.name}: ${row.status}`);
			assert.equal(isDeclaration(row.status), false, "a route status is never a declaration word");
			assert.match(row.measured, /^2026-(?:09-30|10-02), /, `${venue} ${row.name}: dated`);
			assert.ok(!(row.needs + row.measured).includes("|"), `${venue} ${row.name}: no pipe, since the docs render it in a table`);
		}
	}
	assert.throws(() => {
		HOST_ROUTES["docker-engine"][0].status = HOST_ROUTE_REFUTED;
	}, TypeError);
	for (const name of BACKEND_NAMES) assert.equal(Object.hasOwn(BACKENDS[name], "hostRoutes"), false, "routes stay out of the backend entries");
});

test("the table holds exactly what the two published measurement comments state (#503)", () => {
	const routes = Object.fromEntries(Object.entries(HOST_ROUTES).map(([venue, rows]) => [venue, rows.map((r) => `${r.name}=${r.status}`)]));
	assert.deepEqual(routes, {
		"docker-desktop": ["host.docker.internal=works", `${HOST_ROUTE_OWN_ADDRESS}=works`],
		"docker-engine": ["host.docker.internal=works", "host.containers.internal=refuted", `${HOST_ROUTE_OWN_ADDRESS}=works`, `${HOST_ROUTE_OTHER_MACHINE}=reachable`],
		"podman-rootful": ["host.containers.internal=works", `${HOST_ROUTE_OWN_ADDRESS}=works`, `${HOST_ROUTE_OTHER_MACHINE}=reachable`],
		"podman-rootless-slirp4netns": ["host.containers.internal=works", `${HOST_ROUTE_OWN_ADDRESS}=works`, `${HOST_ROUTE_OTHER_MACHINE}=reachable`],
		"podman-rootless-pasta": ["host.containers.internal=works", `${HOST_ROUTE_OWN_ADDRESS}=refuted`, `${HOST_ROUTE_OTHER_MACHINE}=reachable`],
		"every-venue": [`${HOST_ROUTE_LOOPBACK}=refuted`],
	});
	for (const row of HOST_ROUTES["docker-desktop"]) assert.deepEqual({ ...row.when }, { backend: "docker", desktop: true, os: "darwin", version: "27.4.0" }, "Docker Desktop was measured on macOS, engine 27.4.0, only");
	// Issue #530: the one row measured after the two comments, in #503's acceptance run.
	assert.deepEqual(
		Object.values(HOST_ROUTES).flat().filter((r) => !r.measured.startsWith("2026-09-30, ")).map((r) => `${r.name} ${r.measured}`),
		[`${HOST_ROUTE_OWN_ADDRESS} 2026-10-02, Docker Desktop 4.37.2 (engine 27.4.0), macOS`],
	);
	assert.equal(HOST_ROUTES["every-venue"][0].measured, "2026-09-30, true on every runtime by construction, and measured on the four VM runtimes");
	// Details the comments do not publish stay out of the rows.
	const text = Object.values(HOST_ROUTES).flat().map((r) => `${r.needs} ${r.measured}`).join(" ");
	for (const unpublished of ["Fedora 44", "passt", "netavark", "UFW inactive", "alone is refused", "namespace"]) assert.ok(!text.includes(unpublished), unpublished);
});

test("hostRouteFor answers each measured row (#503)", () => {
	const cases = [
		[DESKTOP, "host.docker.internal", HOST_ROUTE_WORKS, /Nothing to add/],
		[{ ...DESKTOP, hostAddresses: DESKTOP_HOST }, "192.168.68.54", HOST_ROUTE_WORKS, /measured 2026-10-02, .*bound to that address/],
		[ENGINE, "host.docker.internal", HOST_ROUTE_WORKS, /--add-host host\.docker\.internal:host-gateway` on the proxy/],
		[ENGINE, "host.containers.internal", HOST_ROUTE_REFUTED, /not defined on Docker Engine/],
		[ENGINE, "192.168.5.15", HOST_ROUTE_WORKS, /bound to that address/],
		[ROOTFUL, "host.containers.internal", HOST_ROUTE_WORKS, /0\.0\.0\.0 only/],
		[ROOTFUL, "192.168.5.15", HOST_ROUTE_WORKS, /bound to that address/],
		[SLIRP, "host.containers.internal", HOST_ROUTE_WORKS, /192\.168\.5\.15/],
		[SLIRP, "192.168.5.15", HOST_ROUTE_WORKS, /bound to that address/],
		[PASTA, "host.containers.internal", HOST_ROUTE_WORKS, /169\.254\.1\.2/],
		[PASTA, "192.168.5.15", HOST_ROUTE_REFUTED, /Declare host\.containers\.internal/],
	];
	for (const [runtime, host, status, needs] of cases) {
		const got = hostRouteFor(runtime, host);
		assert.equal(got.status, status, `${JSON.stringify(runtime)} ${host}: ${got.sentence}`);
		assert.match(got.sentence, needs, host);
		assert.match(got.sentence, /measured 2026-(?:09-30|10-02), /, host);
	}
	// Every works or refuted row is reached by a case, so a new one cannot land untested.
	const reached = cases.map(([runtime, host]) => hostRouteFor(runtime, host).sentence);
	for (const row of Object.values(HOST_ROUTES).flat().filter((r) => r.name !== HOST_ROUTE_LOOPBACK && r.name !== HOST_ROUTE_OTHER_MACHINE)) {
		assert.ok(reached.some((s) => s.endsWith(row.needs) && s.includes(row.measured)), `a case reaches ${row.name} (${row.measured})`);
	}
});

test("another machine is lan, an ordinary outbound route, and never works (#503)", () => {
	for (const runtime of RUNTIMES) {
		for (const host of ["192.168.5.2", "8.8.8.8", "100.64.0.1", "10.0.2.3", "172.17.0.1", "ollama.lan", "myhost.local", "gpu_box.lan", "ollama.example.com"]) {
			const got = hostRouteFor({ ...runtime, hostAddresses: LAN_HOST }, host);
			assert.equal(got.status, HOST_ROUTE_LAN, `${JSON.stringify(runtime)} ${host}: ${got.sentence}`);
			assert.match(got.sentence, /is not a route to this host: an ordinary outbound route through the proxy\. Another machine on the LAN was measured reachable \(IPv4, 192\.168\.5\.2\) on Docker Engine 29\.1\.3, Ubuntu 24\.04; Podman 5\.8\.1 rootful, Fedora; Podman 4\.9\.3 rootless, slirp4netns, Ubuntu 24\.04; Podman 5\.8\.1 rootless, pasta, Fedora\.$/);
		}
	}
	// A name needs no host addresses to be lan: no name but the two aliases is ever this host's route.
	assert.equal(hostRouteFor({ ...ENGINE, hostAddresses: undefined }, "ollama.lan").status, HOST_ROUTE_LAN);
});

test("an address the proxy denies as host-local is refuted on every runtime, from the one shared set (#503)", () => {
	for (const runtime of [...RUNTIMES, {}, null, undefined]) {
		for (const host of ["localhost", "localhost.", "ollama.localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.2.2", "::1", "[::1]", "::", "[::]"]) {
			const got = hostRouteFor(runtime, host);
			assert.equal(got.status, HOST_ROUTE_REFUTED, `${JSON.stringify(runtime)} ${host}: ${got.sentence}`);
			assert.match(got.sentence, /host-local address, and the proxy denies it/);
		}
	}
	assert.deepEqual([...PROXY_LOCAL_ADDRESSES], ["127.0.0.0/8", "0.0.0.0/32", "10.0.2.2/32", "::1", "::/128"]);
	for (const entry of PROXY_LOCAL_ADDRESSES) {
		const base = entry.split("/")[0];
		assert.equal(isProxyLocalHost(base.includes(":") ? "ipv6" : "ipv4", base), true, entry);
	}
	// Link-local stays out, as in LOCAL_ADDRESSES: it is how pasta reaches this host.
	assert.equal(isProxyLocalHost("ipv4", "169.254.1.2"), false);
	assert.equal(isProxyLocalHost("ipv6", "fe80::1"), false);
	assert.equal(isProxyLocalHost("ipv4", "10.0.2.3"), false, "10.0.2.2 is a /32");
	assert.equal(isProxyLocalHost("ipv4", "128.0.0.1"), false);
	assert.equal(isProxyLocalHost("other", "::1"), false, "an unknown kind is never local by default");
});

test("pasta 5.8.1 refuses the host's own LAN address, where slirp4netns 4.9.3 takes it (#503)", () => {
	// The one row where the two rootless helpers split, and the reason the issue's "LAN endpoints only for 4.x" fallback
	// is refuted: 4.9.3 reaches the host, and 5.8.1 reaches it only by host.containers.internal.
	assert.equal(hostRouteFor(PASTA, "192.168.5.15").status, HOST_ROUTE_REFUTED);
	assert.equal(hostRouteFor(SLIRP, "192.168.5.15").status, HOST_ROUTE_WORKS);
	// Without the host's addresses no IPv4 literal is judged: it may be this host's own.
	assert.equal(hostRouteFor({ ...PASTA, hostAddresses: undefined }, "192.168.5.15").status, HOST_ROUTE_UNMEASURED);
	assert.equal(hostRouteFor({ ...SLIRP, hostAddresses: undefined }, "192.168.5.2").status, HOST_ROUTE_UNMEASURED);
});

test("host addresses must each be a plain IPv4, or nothing is judged (#503)", () => {
	for (const bad of ["192.168.5.15/24", "%eth0", "garbage", "[]", "fe80::1", " 192.168.5.15", 7, null]) {
		for (const host of ["192.168.5.15", "192.168.5.2", "ollama.lan", "host.containers.internal"]) {
			const got = hostRouteFor({ ...PASTA, hostAddresses: [...LAN_HOST, bad] }, host);
			assert.equal(got.status, HOST_ROUTE_UNMEASURED, `${JSON.stringify(bad)} ${host}`);
			assert.ok(got.sentence.startsWith(`The host address ${JSON.stringify(bad)} is not a plain IPv4 address`), got.sentence);
		}
	}
	for (const empty of [[], "192.168.5.15", {}]) {
		const got = hostRouteFor({ ...PASTA, hostAddresses: empty }, "192.168.5.15");
		assert.equal(got.status, HOST_ROUTE_UNMEASURED);
		assert.match(got.sentence, /^No host addresses were given/);
	}
});

test("Docker Engine's host.docker.internal names host-gateway on the proxy and the server's bind (#503)", () => {
	const row = HOST_ROUTES["docker-engine"].find((r) => r.name === "host.docker.internal");
	assert.match(row.needs, /`--add-host host\.docker\.internal:host-gateway` on the proxy gives 172\.17\.0\.1/);
	assert.match(row.needs, /even with docker0 down/);
	assert.match(row.needs, /The server listens on 172\.17\.0\.1 or 0\.0\.0\.0\./);
	assert.match(row.needs, /UFW active is unmeasured/);
});

test("anything not measured reads unmeasured, never works (#503)", () => {
	const unmeasured = [
		[SLIRP, "169.254.1.2"],
		[PASTA, "169.254.1.2"],
		[ENGINE, "2001:db8::1"],
		[ENGINE, "[fd00::16]"],
		[ENGINE, "64:ff9b::7f00:1"],
		[ENGINE, "::ffff:a00:1"],
		[ENGINE, "fe80::1"],
		[{ ...PASTA, version: "5.8.2" }, "host.containers.internal"],
		[{ ...PASTA, version: "5.8.1-dev" }, "host.containers.internal"],
		[{ ...SLIRP, version: "5.0.0" }, "192.168.5.15"],
		[{ ...ENGINE, version: "28.0.0" }, "host.docker.internal"],
		[{ ...DESKTOP, os: "linux" }, "host.docker.internal"],
		[{ ...DESKTOP, os: "win32" }, "host.docker.internal"],
		[DESKTOP, "host.containers.internal"],
		[ROOTFUL, "host.docker.internal"],
		[SLIRP, "host.docker.internal"],
		[PASTA, "host.docker.internal"],
		// Issue #530: the Desktop own-address row is bound to what was measured, and widens to nothing else.
		[DESKTOP, "192.168.68.54"],
		[{ ...DESKTOP, version: "27.4.1", hostAddresses: DESKTOP_HOST }, "192.168.68.54"],
		[{ ...DESKTOP, version: "27.5.0", hostAddresses: DESKTOP_HOST }, "192.168.68.54"],
		[{ ...DESKTOP, os: "linux", hostAddresses: DESKTOP_HOST }, "192.168.68.54"],
		[{ ...DESKTOP, os: "win32", hostAddresses: DESKTOP_HOST }, "192.168.68.54"],
		[{ ...DESKTOP, desktop: false, hostAddresses: DESKTOP_HOST }, "192.168.68.54"],
		[{ ...DESKTOP, hostAddresses: DESKTOP_HOST }, "169.254.1.2"],
	];
	for (const [runtime, host] of unmeasured) {
		const got = hostRouteFor(runtime, host);
		assert.equal(got.status, HOST_ROUTE_UNMEASURED, `${JSON.stringify(runtime)} ${host}: ${got.sentence}`);
	}
	assert.equal(hostRouteFor({ ...SLIRP, version: "v4.9.3" }, "host.containers.internal").status, HOST_ROUTE_WORKS, "a leading v is the same version");
	assert.equal(hostRouteFor({ ...SLIRP, helper: "SLIRP4NETNS" }, "host.containers.internal").status, HOST_ROUTE_WORKS, "the helper is lowercased");
	assert.equal(hostRouteFor({ ...ROOTFUL, helper: undefined }, "host.containers.internal").status, HOST_ROUTE_WORKS, "a rootful podman's helper is not read");
});

test("only a host in a declared form is judged: what parseModelEndpoints stores (#503)", async () => {
	const notDeclared = [null, undefined, 12345, "", " ", "1.2.3", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "010.1.1.1", "1.2.3.256", "HOST.docker.internal", " host.docker.internal", "host.docker.internal\n", "host.docker.internal..", ".host.docker.internal", "a@b", "http://x", "host name", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1", "[FD00::2]", "[fd00:0::2]", "fe80::1%eth0", "[zz::1]"];
	for (const host of notDeclared) {
		const got = hostRouteFor(ENGINE, host);
		assert.equal(got.status, HOST_ROUTE_UNMEASURED, JSON.stringify(host));
		assert.match(got.sentence, /is not a declared host form\.$/, JSON.stringify(host));
	}
	assert.equal(hostRouteFor(ENGINE, "host.containers.internal.").status, HOST_ROUTE_REFUTED, "one trailing dot is dropped");
	assert.match(hostRouteFor(ENGINE, "host.docker.internal.").sentence, /host-gateway/);
	// Every host the parser stores is in a declared form, so doctor can pass the parsed host straight through.
	const { parseModelEndpoints } = await import("../src/model-endpoints.mjs");
	const parsed = parseModelEndpoints(JSON.stringify({ version: 1, endpoints: ["Ollama.LAN", "192.168.5.2", "fd00:0:0::2", "host.docker.internal", "gpu_box.lan"].map((host, i) => ({ id: `e${i}`, host, port: 11434, slots: 1 })) }), "/x/model-endpoints.json");
	for (const { host } of parsed) assert.notEqual(hostRouteFor(ENGINE, host).sentence.endsWith("is not a declared host form."), true, host);
});

test("an invalid runtime input reads unmeasured and names what is missing (#503)", () => {
	const inputs = [
		[null, /the runtime \(an object\)/],
		[{ ...ENGINE, backend: "local" }, /backend \("docker" or "podman"\)/],
		[{ ...ENGINE, version: undefined }, /version \(a string\)/],
		[{ ...ENGINE, version: 29 }, /version/],
		[{ ...ENGINE, desktop: undefined }, /desktop \(a boolean, for docker\)/],
		[{ ...DESKTOP, os: undefined }, /os \(a string such as "darwin", for Docker Desktop\)/],
		[{ ...ROOTFUL, rootless: "false" }, /rootless \(a boolean, for podman\)/],
		[{ ...PASTA, helper: undefined }, /helper \("slirp4netns" or "pasta", for rootless podman\)/],
		[{ ...PASTA, helper: "vopono" }, /helper/],
	];
	for (const [runtime, problem] of inputs) {
		const got = hostRouteFor(runtime, "host.docker.internal");
		assert.equal(got.status, HOST_ROUTE_UNMEASURED, JSON.stringify(runtime));
		assert.match(got.sentence, problem, JSON.stringify(runtime));
		assert.match(got.sentence, /is missing or invalid, so no measured route applies to host\.docker\.internal\.$/);
	}
});

test("isPerMachineHost: only the two alias NAMES are a different server on every machine; every address is shared, link-local included", () => {
	// The endpoint slot lease reads this (issue #503, PR #518's gates). A link-local address is unique on its LINK: several
	// hosts on one bridge can reach one neighbour server at 169.254.x.y, so it must take the fleet claim.
	for (const host of ["host.docker.internal", "host.containers.internal", "host.docker.internal."]) assert.equal(isPerMachineHost(host), true, host);
	for (const host of ["169.254.1.2", "[fe80::1]", "fe80::1", "[febf::1]", "gpu.lan", "192.168.5.2", "172.17.0.1", "[fd00::2]", "docker.internal", "", null]) assert.equal(isPerMachineHost(host), false, String(host));
});
