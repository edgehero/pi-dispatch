// L2: the fixed worker removes the helpers 5.4.2 left, and nothing else. Runs after L1 (whose 5.4.2 leftovers it
// expects) on a daemon that answers.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execDockerBounded } from "../../worker/src/backend-local.mjs";
import { helperName, makeCpuReserve, removeLegacyHelpers, reservePlan } from "../../worker/src/cpu-reserve.mjs";
import { IMAGE, containers, sh, write } from "../lib.mjs";

const run = (bin, args, { timeoutMs, maxBuffer }) => execDockerBounded(args, { bin, timeoutMs, maxBuffer });

// An image with labels of its own, as the job image has.
const dir = mkdtempSync(join(tmpdir(), "lab-img-"));
writeFileSync(join(dir, "Dockerfile"), `FROM ${IMAGE}\nLABEL org.opencontainers.image.title=lab dev.pi-dispatch.lab=1\n`);
await sh("docker", ["build", "-q", "-t", "lab-labelled:1", dir], { timeoutMs: 120_000 });
const LABELLED = "lab-labelled:1";

// 5.4.2's argv with `create` for `run`: a container in exactly the state a CLI killed between create and start left.
function old(image, { w = false, line = "", tweak = (a) => a } = {}) {
	const args = ["create", "--rm", "--pull=never", "--user=0:0", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--network=none", "--read-only", "--cgroup-parent=pidispatch.slice", "-v", `/sys/fs/cgroup/pidispatch.slice:/p${w ? "" : ":ro"}`, "--entrypoint", w ? "sh" : "cat", image, ...(w ? ["-c", `echo "${line}" > /p/cpu.max`] : ["/p/cpu.max"])];
	return tweak(args);
}
const before = (a, flag, ...extra) => {
	const i = a.indexOf(flag);
	return [...a.slice(0, i), ...extra, ...a.slice(i)];
};
const without = (a, flag) => a.filter((x) => x !== flag);
const swap = (a, from, to) => a.map((x) => (x === from ? to : x));

async function make(kind, args) {
	const r = await sh("docker", args);
	return { kind, id: r.stdout.trim(), code: r.code, stderr: r.stderr.trim() };
}

const fingerprints = [
	await make("read", old(IMAGE)),
	await make("write-number", old(IMAGE, { w: true, line: "150000 100000" })),
	await make("write-max", old(IMAGE, { w: true, line: "max 100000" })),
	await make("read-labelled-image", old(LABELLED)),
	await make("write-labelled-image", old(LABELLED, { w: true, line: "250000 100000" })),
];
const decoys = [
	await make("named-new-helper", before(old(IMAGE), "--pull=never", "--name", "pi-dispatch-cpu-reserve-deadbeef", "--label", "pi.dispatch.helper=cpu-reserve")),
	await make("extra-label", before(old(IMAGE), "--pull=never", "--label", "x=y")),
	await make("extra-label-on-labelled-image", before(old(LABELLED), "--pull=never", "--label", "x=y")),
	await make("other-file", old(IMAGE, { tweak: (a) => swap(a, "/p/cpu.max", "/p/other") })),
	await make("other-shell", old(IMAGE, { w: true, tweak: (a) => swap(a, 'echo "" > /p/cpu.max', 'echo "1 100000" > /p/cpu.max; true') })),
	await make("other-mount", old(IMAGE, { tweak: (a) => swap(a, "/sys/fs/cgroup/pidispatch.slice:/p:ro", "/tmp:/p:ro") })),
	await make("extra-mount", before(old(IMAGE), "--pull=never", "-v", "/tmp:/q:ro")),
	await make("not-read-only", without(old(IMAGE), "--read-only")),
	await make("bridge-network", swap(old(IMAGE), "--network=none", "--network=bridge")),
	await make("no-auto-remove", without(old(IMAGE), "--rm")),
	await make("other-user", swap(old(IMAGE), "--user=0:0", "--user=1000:1000")),
	await make("other-parent", swap(old(IMAGE), "--cgroup-parent=pidispatch.slice", "--cgroup-parent=other.slice")),
];

const l1 = (await containers(["status=created"])).filter((c) => c.command.includes("/p/cpu.max") && !c.name.startsWith("pi-dispatch-cpu-reserve-"));
const decoyIds = new Set(decoys.map((d) => d.id));
const l1Leftovers = l1.filter((c) => !decoyIds.has(c.id) && !fingerprints.some((f) => f.id === c.id)).map((c) => c.id);

// Young: by this process's clock every one of them is under ten minutes old, so nothing goes.
const young = await removeLegacyHelpers({ run, now: () => Date.now() });

// The worker's own path: a read that holds, then the one pass, with a clock eleven minutes ahead.
const events = [];
const ahead = () => Date.now() + 11 * 60_000;
const reserve = makeCpuReserve({ run, image: IMAGE, name: helperName("lab-worker-2"), now: ahead, log: (event, fields) => events.push({ event, ...fields }) });
const plan = reservePlan({ venue: "local", facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2" }, endpointLocal: true, platform: "linux" });
const t0 = Date.now();
await reserve.sync({ cpuCenti: 150, plans: [plan] });
const passMs = Date.now() - t0;
const state1 = reserve.states()[0];

// Once per process: a fresh fingerprint after the pass stays through the next held read.
const late = await make("late-fingerprint", old(IMAGE));
await reserve.sync({ cpuCenti: 150, plans: [plan] });

const left = new Set((await containers(["status=created"])).map((c) => c.id));
const fpGone = fingerprints.filter((f) => !left.has(f.id)).map((f) => f.kind);
const fpLeft = fingerprints.filter((f) => left.has(f.id)).map((f) => f.kind);
const l1Gone = l1Leftovers.filter((id) => !left.has(id)).length;
const decoysGone = decoys.filter((d) => !left.has(d.id)).map((d) => d.kind);
const lateLeft = left.has(late.id);
const removedLines = events.filter((e) => e.event === "cpu_reserve_leftovers_removed");

await sh("docker", ["rm", "-f", ...decoys.map((d) => d.id), late.id]);

write("l2-legacy", {
	summary: {
		pass: young.removed === 0 && state1.status === "held" && fpLeft.length === 0 && l1Gone === l1Leftovers.length && decoysGone.length === 0 && lateLeft && removedLines.length === 1,
		youngRemoved: young.removed,
		heldFirst: state1.status,
		fingerprintsLeft: fpLeft,
		l1LeftoversRemoved: `${l1Gone}/${l1Leftovers.length}`,
		decoysRemoved: decoysGone,
		lateFingerprintKept: lateLeft,
		removedLines,
		passMs,
	},
	young,
	fingerprints,
	decoys,
	fpGone,
	events,
});
