import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_FRESH_MS, capabilityTokens, jobNeeds, parseCaps, routeForgeJob, serializeCaps } from "../src/capabilities.mjs";

const host = (name, caps, { routes = "true", staleMs = 0 } = {}) => ({ name, caps, routes, staleMs });

// --- what a host advertises ------------------------------------------------------------------------------

test("a host advertises profile NAMES, never the paths behind them", () => {
	// The registry's content rule is names, integers and digests -- never a path. A resolver path is
	// operator topology everywhere and carries the OS account name on Windows, and the receiver only needs
	// to know WHICH host can serve a job, never what it runs to do it.
	const caps = capabilityTokens({
		secretProfiles: { prod: "/opt/vault/read.sh", staging: "/opt/vault/stage.sh" },
		waitProfiles: { ci: "/usr/local/bin/green.sh" },
	});
	assert.deepEqual(caps, ["s:prod", "s:staging", "w:ci"]);
	assert.equal(serializeCaps(caps).includes("/"), false, "no path can reach the registry through this");
});

test("the advertisement is SORTED, so a row does not churn every beat", () => {
	const a = capabilityTokens({ secretProfiles: { b: 1, a: 1 }, waitProfiles: { c: 1 } });
	const b = capabilityTokens({ waitProfiles: { c: 1 }, secretProfiles: { a: 1, b: 1 } });
	assert.deepEqual(a, b);
});

test("a peer's advertisement is re-validated, because a peer wrote it", () => {
	// These rows cross a trust boundary and this value decides where money-spending work goes. An unknown
	// class letter, a path-shaped name and an empty half all have to fall out rather than become a token
	// some future reader treats as meaningful.
	assert.deepEqual([...parseCaps("s:prod,x:evil,s:../../etc,w:ci,,:bad,s:,w")], ["s:prod", "w:ci"]);
	assert.deepEqual([...parseCaps(undefined)], [], "an absent field is no capability, never a crash");
});

// --- what a job needs ------------------------------------------------------------------------------------

test("a job needs exactly what the worker would refuse it for", () => {
	assert.deepEqual(jobNeeds({ secretsProfile: "prod" }), ["s:prod"]);
	assert.deepEqual(jobNeeds({ waitFor: [{ profile: "ci" }, { after: "2026-01-01" }] }), ["w:ci"]);
	assert.deepEqual(jobNeeds({ secretsProfile: "prod", waitFor: [{ profile: "ci" }] }), ["s:prod", "w:ci"]);
	assert.deepEqual(jobNeeds({}), [], "an ordinary delivery needs nothing and must pay nothing");
	assert.deepEqual(jobNeeds({ secretsProfile: "../etc/passwd" }), [], "a name this deployment would not accept is not a need");
});

// --- the routing rule, one test per abstention -----------------------------------------------------------

const two = [host("mini1", "s:prod,w:ci"), host("mini2", "w:ci")];

test("ABSTAIN 1: a job that binds nothing is never routed", () => {
	assert.equal(routeForgeJob({ hosts: two, needs: [], jobId: "j" }), null);
});

test("ABSTAIN 2: when EVERY live host can serve it, the shared queue is better", () => {
	// Not merely equivalent -- better. The shared queue load-balances, and declaring the same profiles on
	// every host is exactly what the docs tell operators to do, so the recommended deployment is
	// byte-identical to before this existed.
	assert.equal(routeForgeJob({ hosts: two, needs: ["w:ci"], jobId: "j" }), null);
});

test("ABSTAIN 3: when NO host can serve it, the existing pre-spend refusal is the honest answer", () => {
	// `secret-profile-unknown` already names what to fix. Inventing a new terminal state for "nobody has
	// this" would be a second way to say the same thing, and a worse one, since the job would never reach
	// the gate that explains itself.
	assert.equal(routeForgeJob({ hosts: two, needs: ["s:nowhere"], jobId: "j" }), null);
});

test("ABSTAIN 4: a capable host with no queue of its own cannot be routed to", () => {
	// Only a host that DECLARED a name drains a queue. An undeclared one reads the shared queue only, so
	// routing to it would be routing into a queue nothing drains -- a job that never runs at all.
	assert.equal(routeForgeJob({ hosts: [host("mini1", "s:prod", { routes: "false" }), host("mini2", "")], needs: ["s:prod"], jobId: "j" }), null);
	assert.equal(routeForgeJob({ hosts: [], needs: ["s:prod"], jobId: "j" }), null, "an unreadable registry routes nothing");
});

test("otherwise the job goes to a host that can actually serve it", () => {
	assert.equal(routeForgeJob({ hosts: two, needs: ["s:prod"], jobId: "j" }), "mini1");
	assert.equal(routeForgeJob({ hosts: two, needs: ["s:prod", "w:ci"], jobId: "j" }), "mini1", "ALL needs must be met by ONE host");
});

test("a host must be BEATING to attract work, not merely unexpired", () => {
	// The 90s TTL answers "has this host definitely gone" and is deliberately six missed beats so a blip
	// cannot evict a working host from the panel. A routing decision needs the opposite polarity: a job
	// routed onto a dead host's queue sits there until it returns, and nothing else will take it.
	const stale = [host("mini1", "s:prod", { staleMs: ROUTE_FRESH_MS + 1 }), host("mini2", "")];
	assert.equal(routeForgeJob({ hosts: stale, needs: ["s:prod"], jobId: "j" }), null);
	const fresh = [host("mini1", "s:prod", { staleMs: ROUTE_FRESH_MS - 1 }), host("mini2", "")];
	assert.equal(routeForgeJob({ hosts: fresh, needs: ["s:prod"], jobId: "j" }), "mini1");
	const undatable = [{ name: "mini1", caps: "s:prod", routes: "true" }, host("mini2", "")];
	assert.equal(routeForgeJob({ hosts: undatable, needs: ["s:prod"], jobId: "j" }), null, "a row we cannot date is not evidence of life");
});

test("the choice is DETERMINISTIC per job and spread across capable hosts", () => {
	// Deterministic because a forge redelivery must land the same way: the jobId is the dedup id, so a
	// redelivery that chose a different host would still dedup, and the two decisions must agree about
	// where the surviving job went. Spread because a delivery fanned out into replicas is meant to run in
	// parallel, and piling every replica onto one machine would defeat that.
	const many = [host("a", "s:prod"), host("b", "s:prod"), host("c", "s:prod"), host("d", "")];
	const pick = (id) => routeForgeJob({ hosts: many, needs: ["s:prod"], jobId: id });
	assert.equal(pick("gh:acme/web:d-1"), pick("gh:acme/web:d-1"));
	const counts = {};
	for (let i = 0; i < 3000; i++) {
		const q = pick(`gh:acme/web:delivery-${i}`);
		counts[q] = (counts[q] ?? 0) + 1;
	}
	assert.deepEqual(Object.keys(counts).sort(), ["a", "b", "c"], "never the host that cannot serve it");
	for (const n of Object.values(counts)) assert.ok(n > 700 && n < 1300, `even spread, got ${JSON.stringify(counts)}`);
});

test("host ORDER does not change the answer, so two receivers agree", () => {
	const forward = [host("a", "s:prod"), host("b", "s:prod"), host("z", "")];
	const reversed = [host("z", ""), host("b", "s:prod"), host("a", "s:prod")];
	for (const id of ["j1", "j2", "j3", "j4"]) {
		assert.equal(routeForgeJob({ hosts: forward, needs: ["s:prod"], jobId: id }), routeForgeJob({ hosts: reversed, needs: ["s:prod"], jobId: id }));
	}
});
