import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PODMAN_JOB_USER_FIX, podmanJobUserRefusal } from "../src/backend-podman.mjs";
import { BACKENDS, DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, PODMAN_BACKEND, PROPERTIES, PROPERTY_NAMES, RUNTIME_ADDS_NO_MOUNTS, effectiveWord, meets } from "../src/backends.mjs";
import { buildDockerRunArgs } from "../src/docker-run.mjs";
import { DEFAULT_EGRESS_PROXY } from "../src/egress.mjs";
import { BOOT_REFUSING_JOB_USER_CAUSES, JOB_USER_FIX, jobUserRefusal } from "../src/job-user.mjs";
import { sandboxVenueRefusal } from "../src/sandbox.mjs";
import { podmanBootRefusal } from "../src/start.mjs";

// docs/podman.md's property table restates two derivable sources, so it is BOLTED to them (CLAUDE.md: a hand-written
// table is derived or pinned, never trusted): its rows are the backend table's properties in order, and its Docker
// Engine column is what `local` declares. The Podman columns are measurements, which no source can derive, and the
// first review of this file showed why pinning only their VOCABULARY is not enough: a page that said `isolation:
// enforced` in every Podman column passed. So each Podman column also names the OBSERVATIONS that column describes,
// and its word is capped by `effectiveWord` under them -- a word the worker could never print on that host now fails
// here. What stays unpinned is the rest of a cell's sentence, which is prose about a measurement.
//
// WHAT THIS FILE DELIBERATELY DOES NOT PIN, and the history is worth the lines because it keeps recurring: prose
// about WHEN a job-user refusal fires. The page got that subtly wrong three review rounds running under #345
// (`9cb2bce`'s own message says so), and the eventual answer was NOT a bigger regex here. Nothing in this file was
// ever widened to chase it: `REFUSED_ENTRY_POINT` below was written once and has been byte-identical since, and it
// governs the ENTRY-POINTS table anyway, while the refusal block's own test reads only the `Refused:` lines. The
// timing clauses were never in range of either. `9cb2bce` moved the "Where a refusal fires is one rule" paragraph
// off the page instead, onto `DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST`, which owns it, and that is the shape of
// the answer. Not all of it went: the refusal lists above that paragraph still say when each cause fires.
//
// It did not end there, which is the part to remember. `9cb2bce`'s own deferral first named `docs/backends.md`
// beside the design entry, and the very next commit (`0335146`) had to take that pointer back out, on the ground
// that the page does not in fact carry the detail and a pointer to a page without the answer is worse than none;
// the same commit corrected one of the page's eight refusal headings from "(at boot)" to "(at boot when local is
// the default venue, else per job)". So the recurrence ran to FOUR rounds, and even the fix for it needed fixing.
// A timing clause still sits in each of those eight headings, unpinned on purpose: a regex over them would pin
// their SHAPE and never their truth, and a green regex over a false sentence is worse than no test. So the answer
// to the next recurrence is to DERIVE the claim from what a function returns, the way every test below is derived,
// or to delete the sentence -- and a page becomes a legitimate pointer only once it carries the detail AND is
// bolted to the source of it. Adding a regex over prose here would repeat what has already failed four times.

const doc = readFileSync(new URL("../../docs/podman.md", import.meta.url), "utf8");

// The seven setups, in the order both of the page's tables use them, with what the worker observes on each. A column
// with `refusal` runs no job at all, so its cells are the refusal rather than a word. The first six are the `local`
// venue on each runtime; the seventh is a venue of its own (issue #354), marked `native`, whose column is the
// `podman` table entry itself rather than a measurement capped by `local`'s words.
const SETUPS = Object.freeze([
	{ header: "Docker Engine, rootful", observations: { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: true, [RUNTIME_ADDS_NO_MOUNTS]: true } },
	{ header: "Podman rootful", observations: { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: false, [RUNTIME_ADDS_NO_MOUNTS]: true } },
	{ header: "Podman rootless, keep-id, Docker API", refusal: "rootless" },
	{ header: "Podman rootless, Docker API", refusal: "rootless" },
	{ header: "podman-docker, rootful", observations: { [DOCKER_ENDPOINT_LOCAL]: false, [DAEMON_APPLIES_BOUNDS]: false, [RUNTIME_ADDS_NO_MOUNTS]: true } },
	{ header: "podman-docker, rootless", refusal: "rootless" },
	{ header: "podman (native, rootless)", native: PODMAN_BACKEND },
]);

function propertyTable() {
	const start = doc.indexOf("<!-- PODMAN-PROPERTY-TABLE -->");
	const end = doc.indexOf("<!-- /PODMAN-PROPERTY-TABLE -->");
	assert.ok(start >= 0 && end > start, "the table is between its markers");
	const rows = doc
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
	const [header, separator, ...body] = rows;
	assert.match(separator.join(""), /^-+$/);
	return { header, body };
}

test("the Podman property table's rows are the backend table's properties, in order (#345)", () => {
	const { header, body } = propertyTable();
	assert.equal(header[0], "Property");
	assert.deepEqual(header.slice(1), SETUPS.map((setup) => setup.header));
	assert.deepEqual(body.map((row) => row[0]), [...PROPERTY_NAMES]);
});

test("its Docker Engine column is what `local` declares, word for word (#345)", () => {
	const { body } = propertyTable();
	for (const [property, dockerEngine] of body) {
		assert.equal(/^\S+/.exec(dockerEngine)?.[0], BACKENDS.local.declares[property], property);
	}
});

// The teeth. A cell must say exactly what its setup's observations earn, which is at most what `local` declares
// (`effectiveWord` never raises a word). `isolation: enforced` on any Podman column dies here, because
// `observeBounds` returns false for every Podman daemon, and the `meets` check below names that case separately
// so the failure says which of the two rules a cell broke. The native column is the next test's.
test("every Podman cell is a word its own setup could actually earn, or its refusal (#345)", () => {
	const { body } = propertyTable();
	for (const row of body) {
		const property = row[0];
		for (const [index, setup] of SETUPS.entries()) {
			const cell = row[index + 1];
			if (setup.native) continue;
			if (setup.refusal) {
				assert.equal(cell, `refused: ${setup.refusal}`, `${property} on ${setup.header}`);
				assert.ok(BOOT_REFUSING_JOB_USER_CAUSES.has(setup.refusal), setup.refusal);
				continue;
			}
			const [, word] = /^(enforced|asserted|absent)\b/.exec(cell) ?? [];
			assert.ok(word, `${property} on ${setup.header}: ${cell}`);
			assert.ok(meets(BACKENDS.local.declares[property], word), `${property} on ${setup.header} claims more than local declares`);
			assert.equal(word, effectiveWord("local", property, setup.observations), `${property} on ${setup.header}`);
		}
	}
});

// The native venue's column (issue #354), DERIVED from its own table entry the way the Docker Engine column is from
// `local`'s. Three parts of each cell are the table's, so each is pinned: the leading word is what the entry declares
// with every observation holding (`effectiveWord`, so a word the worker could never print there fails); a word that
// holds only while observed must say what it falls to otherwise, which is `effectiveWord` with nothing observed; and a
// word a switch arms must name the switch, so the capability is never printed bare as a posture. The rest of the cell
// is prose about a measurement and stays unpinned.
test("the native podman column is what the `podman` table entry declares, observed and armed (#354)", () => {
	const { body } = propertyTable();
	const index = SETUPS.findIndex((setup) => setup.native === PODMAN_BACKEND);
	const entry = BACKENDS[PODMAN_BACKEND];
	const allObserved = Object.fromEntries(Object.values(entry.observedBy).map((observation) => [observation, true]));
	for (const row of body) {
		const [property] = row;
		const cell = row[index + 1];
		const word = effectiveWord(PODMAN_BACKEND, property, allObserved);
		assert.equal(word, entry.declares[property], `${property}: every observation holding earns the declared word`);
		assert.equal(/^(enforced|asserted|absent)\b/.exec(cell)?.[1], word, `${property} on the native column: ${cell}`);
		const unobserved = effectiveWord(PODMAN_BACKEND, property, {});
		if (Object.hasOwn(entry.observedBy, property)) {
			assert.notEqual(unobserved, word, `${property} is observation-gated, so nothing observed must lower it`);
			assert.ok(cell.endsWith(`, else ${unobserved}`), `${property}: an observed word says what it is otherwise (${cell})`);
		} else {
			assert.doesNotMatch(cell, /\belse\b/, `${property} is not observation-gated, so it falls to nothing (${cell})`);
		}
		const armedBy = PROPERTIES[property].armedBy;
		if (armedBy) assert.ok(cell.includes(`(${armedBy})`), `${property}: the switch that arms it is named (${cell})`);
		else assert.doesNotMatch(cell, /PI_EGRESS/, `${property} is armed by nothing (${cell})`);
	}
});

// The page quotes the refusal an operator sees. A quote is a copy, and a copy drifts, so the block is pinned to
// `jobUserRefusal` itself: a line the function cannot produce fails here rather than in a support thread, and a
// cause the page quietly stops quoting fails too.
test("the page quotes every refusal the worker can print, verbatim (#345)", () => {
	const start = doc.indexOf("<!-- PODMAN-REFUSAL-TEXTS -->");
	const end = doc.indexOf("<!-- /PODMAN-REFUSAL-TEXTS -->");
	assert.ok(start >= 0 && end > start, "the refusal block is between its markers");
	const quoted = doc
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("Refused:"));
	const byText = new Map(Object.keys(JOB_USER_FIX).map((cause) => [jobUserRefusal(cause), cause]));
	const covered = new Set();
	for (const line of quoted) {
		const cause = byText.get(line);
		assert.ok(cause, `not a text the worker prints: ${line}`);
		assert.ok(!covered.has(cause), `quoted twice: ${cause}`);
		covered.add(cause);
	}
	assert.deepEqual([...covered].sort(), Object.keys(JOB_USER_FIX).sort());
});

// The entry-points table is the same seven setups in the same order, so it is pinned to the same list. Its cells are
// prose rather than declaration words, but a column whose jobs are all refused may only say so: an entry point that
// claims to run something there would be a page that contradicts its own property table.
const REFUSED_ENTRY_POINT = /^(refused `[a-z-]+`|✗ `[a-z-]+`|not run\b.*|as doctor|unmeasured\b.*)$/;

// The rows, by name, so a row cannot be dropped, renamed or invented while the count stays right.
const ENTRY_POINTS = Object.freeze(["worker", "`pi-dispatch doctor`", "`pi-dispatch doctor --live`", "`pi-dispatch sandbox`", "`pi-dispatch up`", "`docker compose --profile egress`"]);

// The native venue's column is neither: its jobs run, and exactly one entry point refuses them. That one is not a
// sentence to trust either, so it is asked of the code: a retained run stamped with the venue is refused by the
// sandbox's own venue rule. Every other row of the column must not claim a refusal it does not get.
const NATIVE_REFUSED_ENTRY_POINTS = Object.freeze(["`pi-dispatch sandbox`"]);

test("the entry-points table covers the same seven setups, and a refused column only refuses (#345)", () => {
	const start = doc.indexOf("## Entry points");
	const end = doc.indexOf("##", start + 3);
	const rows = doc
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
	const [header, separator, ...body] = rows;
	assert.match(separator.join(""), /^-+$/);
	assert.equal(header[0], "Entry point");
	assert.deepEqual(header.slice(1), SETUPS.map((setup) => setup.header));
	assert.deepEqual(body.map((row) => row[0]), [...ENTRY_POINTS]);
	for (const row of body) {
		for (const [index, setup] of SETUPS.entries()) {
			const cell = row[index + 1];
			if (setup.native) {
				if (NATIVE_REFUSED_ENTRY_POINTS.includes(row[0])) {
					assert.match(cell, /^refused\b/, `${row[0]} on ${setup.header}: ${cell}`);
					assert.ok(sandboxVenueRefusal({ jobId: "j", manifest: { backend: setup.native } }), `the sandbox really refuses a ${setup.native} run`);
				} else {
					assert.doesNotMatch(cell, /refus|✗/, `${row[0]} on ${setup.header} claims a refusal it does not get`);
				}
				continue;
			}
			if (!setup.refusal) {
				// The rule has to run both ways, or a supported column can quietly claim it is refused.
				assert.doesNotMatch(cell, /refus|✗/, `${row[0]} on ${setup.header} claims a refusal it does not get`);
				continue;
			}
			assert.match(cell, REFUSED_ENTRY_POINT, `${row[0]} on ${setup.header}: ${cell}`);
			// "not run" and "unmeasured" carry a tail, and the tail must not put back what the cell just denied.
			assert.doesNotMatch(cell.replace(/^(not run|unmeasured)/, ""), /\bruns?\b|\bopens\b|\breads\b|\bstarts\b/, `${row[0]} on ${setup.header} claims a run anyway`);
			// "as doctor" says "whatever the doctor row says", which is only true of the row that really does that.
			if (cell === "as doctor") assert.equal(row[0], "`pi-dispatch up`", `${row[0]} cannot defer to doctor`);
			if (/`[a-z-]+`/.test(cell)) assert.ok(cell.includes(`\`${setup.refusal}\``), `${row[0]} on ${setup.header} names another cause`);
		}
	}
});

// The native venue's refusals (issue #354), pinned the way the block above is, and one step further: each heading's
// TIMING is derived as well. The block above leaves its headings' "(at boot ...)" clauses unpinned, and this file's
// header says why a regex over them would be worse than nothing; here the clause is BUILT from `podmanBootRefusal`,
// the function the boot calls, so there is one correct heading tail per cause and the page has it or does not.
const NATIVE_BOOT = "(at boot when podman is the default venue, else per job)";
const NATIVE_PER_JOB = "(per job)";

test("the page quotes every refusal the podman venue can print, and when each fires (#354)", () => {
	const start = doc.indexOf("<!-- PODMAN-NATIVE-REFUSALS -->");
	const end = doc.indexOf("<!-- /PODMAN-NATIVE-REFUSALS -->");
	assert.ok(start >= 0 && end > start, "the native refusal block is between its markers");
	const lines = doc.slice(start, end).split("\n");
	const byText = new Map(Object.keys(PODMAN_JOB_USER_FIX).map((cause) => [podmanJobUserRefusal(cause), cause]));
	const covered = new Set();
	lines.forEach((line, i) => {
		if (!line.startsWith("Refused:")) return;
		const cause = byText.get(line);
		assert.ok(cause, `not a text the podman venue prints: ${line}`);
		assert.ok(!covered.has(cause), `quoted twice: ${cause}`);
		covered.add(cause);
		const heading = lines[i - 1] ?? "";
		const stopsBoot = podmanBootRefusal({ mode: "unmappable", cause }, PODMAN_BACKEND) !== null;
		assert.ok(heading.startsWith("# "), `${cause} has a heading line above it`);
		assert.ok(heading.endsWith(stopsBoot ? NATIVE_BOOT : NATIVE_PER_JOB), `${cause}: ${heading}`);
	});
	assert.deepEqual([...covered].sort(), Object.keys(PODMAN_JOB_USER_FIX).sort());
});

// The proxy command the native setup gives restates two things the worker and the compose file already say: the
// name the worker attaches to every job network, and the digest the compose file pins. Both drift silently in prose
// (a digest bumped in one file only), so both are read off their sources.
test("the native setup's proxy is the compose file's image, under the name the worker attaches (#354)", () => {
	const start = doc.indexOf("<!-- PODMAN-NATIVE-PROXY -->");
	const end = doc.indexOf("<!-- /PODMAN-NATIVE-PROXY -->");
	assert.ok(start >= 0 && end > start, "the proxy command is between its markers");
	const block = doc.slice(start, end);
	const compose = readFileSync(new URL("../../deploy/docker-compose.yml", import.meta.url), "utf8");
	const image = /^\s*image:\s*(ubuntu\/squid@sha256:[0-9a-f]{64})\s*$/m.exec(compose)?.[1];
	assert.ok(image, "the compose file pins the proxy by digest");
	// Fully qualified for Podman, whose short-name resolution may refuse or prompt where Docker assumes docker.io.
	assert.ok(block.includes(` docker.io/${image}\n`), `the command runs docker.io/${image}`);
	assert.equal(block.split("sha256:").length - 1, 1, "one image, one digest");
	assert.match(block, new RegExp(`--name ${DEFAULT_EGRESS_PROXY} `), "the name the worker attaches to each job network");
});

// The real-host table (issue #355). Its rows are measurements, which no source can derive, so what is pinned is the
// part that CAN drift silently: the markers, the four-word Result vocabulary, each row's version and date shape, the
// rows by name, and the two `argv:` words, which restate what the argv builder and the compose file emit. A word
// the builder does not produce is a page telling an operator to expect a flag no job carries.
const HOST_ROWS = Object.freeze([
	"SELinux: the worker's own per-job mounts",
	"SELinux: an operator's local folder, unlabelled",
	"SELinux: the global overlay, unlabelled",
	"SELinux: SecurityOptions carries name=selinux",
	"nftables: egress reaches the provider and denies an unlisted host",
	"nftables: jobToJobIsolation",
	"Health checks under systemd",
	"SELinux: the compose file's config mounts",
	"Setup step 2, the socket for the worker's group",
]);

function hostTable() {
	const start = doc.indexOf("<!-- PODMAN-HOST-ROWS -->");
	const end = doc.indexOf("<!-- /PODMAN-HOST-ROWS -->");
	assert.ok(start >= 0 && end > start, "the real-host table is between its markers");
	const rows = doc
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
	const [header, separator, ...body] = rows;
	assert.match(separator.join(""), /^-+$/);
	assert.deepEqual(header, ["Row", "Result", "Podman", "Date"]);
	return body.map(([row, result, podman, date]) => ({ row, result, podman, date }));
}

test("the real-host table names its rows, speaks the four-word vocabulary, and dates every row (#355)", () => {
	const body = hostTable();
	assert.deepEqual(body.map((r) => r.row), [...HOST_ROWS]);
	for (const { row, result, podman, date } of body) {
		assert.match(result, /^(measured|refused: \S.*|argv: :\S+|doc: \S.*)$/, `${row}: ${result}`);
		assert.match(podman, /^\d+\.\d+\.\d+$/, `${row}: a Podman version, not ${podman}`);
		// An ISO calendar date that is a real day: `Date` rolls 2026-02-30 over to March, so the round trip catches it.
		assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${row}: ${date}`);
		assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date, `${row}: ${date} is not a calendar day`);
	}
});

// The `argv:` word of the per-job row, derived from the builder rather than copied. Built both ways on purpose: with
// `relabel` every mount the worker makes carries exactly the word's options on top of its own `ro`, the overlay
// carries none, and without it no mount carries any (the byte-identical promise for every other daemon).
test("the per-job row's argv word is what the job argv builder emits with relabel on (#355)", () => {
	const row = hostTable().find((r) => r.row === HOST_ROWS[0]);
	const word = /^argv: :(\S+)$/.exec(row.result)?.[1];
	assert.ok(word, row.result);
	const base = { image: "pi-job:test", name: "pi-job-doc", env: {}, jobDir: "/j", workspace: "/w", outboxDir: "/o", sessionDir: "/s", globalPiDir: "/g" };
	const options = (args) => {
		const byContainer = {};
		args.forEach((arg, i) => {
			if (args[i - 1] !== "-v") return;
			const [, container, opts = ""] = arg.split(":");
			byContainer[container] = opts === "" ? [] : opts.split(",");
		});
		return byContainer;
	};
	const on = options(buildDockerRunArgs({ ...base, relabel: true, workspaceOwned: true }));
	assert.deepEqual(on, { "/job": ["ro", word], "/workspace": [word], "/outbox": [word], "/session": [word], "/opt/pi-global": ["ro"] });
	assert.ok(buildDockerRunArgs({ ...base, relabel: true, workspaceOwned: true }).includes(`/j:/job:ro,${word}`), "the /job mount is one `-v` value, `ro` first");
	// A local job's workspace is the operator's folder, and is never relabelled.
	assert.deepEqual(options(buildDockerRunArgs({ ...base, relabel: true }))["/workspace"], []);
	const off = options(buildDockerRunArgs(base));
	assert.deepEqual(off, { "/job": ["ro"], "/workspace": [], "/outbox": [], "/session": [], "/opt/pi-global": ["ro"] });
});

// The compose row's word, against both copies of the compose file (they are a pinned mirror, but this reads each so a
// failure names the one that moved). The three single config files a service reads carry exactly that option list.
test("the compose row's argv word is what the compose file's config mounts carry (#355)", () => {
	const row = hostTable().find((r) => r.row === "SELinux: the compose file's config mounts");
	const word = /^argv: :(\S+)$/.exec(row.result)?.[1];
	assert.ok(word, row.result);
	for (const path of ["../../deploy/docker-compose.yml", "../deploy/docker-compose.yml"]) {
		const compose = readFileSync(new URL(path, import.meta.url), "utf8");
		for (const target of ["/etc/squid/squid.conf", "/etc/pi-dispatch/allowlist.conf", "/config/triggers.json"]) {
			const mount = compose.split("\n").map((line) => line.trim()).find((line) => line.startsWith("- ") && line.includes(`:${target}`));
			assert.ok(mount, `${path} mounts ${target}`);
			assert.equal(mount.slice(mount.indexOf(`:${target}`) + target.length + 1), `:${word}`, `${path}: ${mount}`);
		}
	}
});
