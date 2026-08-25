/**
 * `pi-dispatch doctor` — preflight the host before the first job. Prints a ✓/⚠/✗ line per prerequisite
 * with a one-line fix, and exits non-zero if any hard check fails, so it is usable in a setup script.
 *
 * Reads the handful of values it needs with config.mjs's own defaults rather than loadConfig, so it
 * runs even when GitHub auth is unset — a local-folder deployment needs none of it. Mirrors the kill
 * switch in cli.mjs, which reads only VALKEY_URL for the same reason (it must work when GitHub is
 * misconfigured). The provider key is checked for presence only and never printed (secrets-and-pii).
 *
 * GitHub auth gets two advisory (never failing) checks: the default GITHUB_AUTH_SOURCE=gh mints from the
 * operator's FULL-scope gh login, which then reaches every token-carrying job container — the opposite of
 * the App path's per-repo short-lived tokens (CONST-TOKEN-SCOPED-PER-JOB) — so doctor names the scopes it
 * carries; and gh is preflighted inside the job image, since a token that works host-side but not
 * in-container fails jobs mid-run, not at submit. Token values travel via the spawn env only, never argv.
 *
 * Issue #80 adds the RECEIVER's half of the preflight. Doctor runs on the worker host, but the triggers
 * file names forges whose deliveries only ever arrive if the receiver can boot -- and the receiver is
 * deliberately fail-loud (receiver/src/config.mjs), so a missing WEBHOOK_SECRET or a half-set forge env
 * block is a refusal the operator otherwise meets at deploy time with no forewarning. Doctor mirrors
 * exactly the variables each forge loader hard-requires and WARNS about what boot will refuse -- never
 * fails, because the worker host may legitimately not be the receiver host, and a deployment can be
 * mid-setup. Secrets are checked for presence only and never printed, same rule as the provider key. The
 * github repos the triggers file names also get a READ-ONLY branch-protection preflight, so
 * REQ-BRANCH-PROTECTION-PRECONDITION surfaces at setup time instead of as a refusal comment on the first
 * paid trigger.
 *
 * The overlay checks (REQ-GLOBAL-PI-OVERLAY, INT-TRIGGERS-FILE-CONTRACT) exist because nothing about the
 * overlay is visible from the worker host once jobs are running. BOTH halves of it -- `extensions/` and the
 * staged `packages/` -- now load by default, so the state worth surfacing is no longer "armed": an armed
 * thing is one the operator just switched on and remembers. The dangerous state now is STAGED AND FORGOTTEN,
 * so doctor's overlay lines answer "what will actually load into my job containers", and the ⚠ marks the
 * live third-party code rather than the switch.
 *
 * The silent-failure checks that outlive the flip are unchanged, because they never depended on the default:
 * a manifest naming a staged dir that is gone, and a trigger that explicitly requires packages nobody staged.
 * Both end the same way -- pi skips an absent local source with no error, and the flow exits 0 without the
 * tools it was written for.
 *
 * `doctor --fix` (issue #80, REQ-DEPLOYMENT-BOOTSTRAP) turns SOME fix lines into offers, per failing check.
 * The tier ladder is deliberate: a silent tier for the two fixes whose decision the operator already made
 * (init's create-only scaffolds; mkdir of a directory an env var already names), a prompt tier (y/N,
 * default No, the exact command shown first) for the rest, and a never tier for everything doctor could
 * only fix by guessing -- see the fixAction comment at its first use below. Offering fixes changes NOTHING
 * about severity: a --fix run still exits by the same failed/ok logic, warns stay warns, and the fix pass
 * happens at most once (check, fix, re-check -- never a loop).
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { defaultSandboxDir, globalExtensionsEnabled } from "./config.mjs";
import { isForgeKind } from "./forges.mjs";
import { findLiteralSecret, ADMIN_RE } from "./import-pi.mjs";
import { agentDirFrom, readHostPi } from "./host-pi.mjs";
import { PACKAGES_SUBDIR, readStagedSkills, readStageManifest } from "./packages.mjs";
import { copySkillTree } from "./copy-tree.mjs";
import { SKILL_NAME_RE } from "./flow-gate.mjs";
import { parseTriggers } from "./triggers.mjs";

const NODE_FLOOR = [22, 19]; // pi's engine floor (22.19.0)

// Which env var holds the credential for each provider. Presence is checked, value never read out.
// anthropic lists the OAuth token too because it silently takes precedence over the API key upstream.
const PROVIDER_KEYS = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	openai: ["OPENAI_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

// gh login scopes that reach well past what a job should ever hold — called out by name in the fix line.
const BROAD_SCOPES = ["admin:org", "delete_repo", "workflow"];

// The loopback Valkey, as one docker argv. Mirrors deploy/docker-compose.yml exactly: AOF on (the
// wait-list must survive a reboot, REQ-QUEUE-BURST-NO-DROP), bound to 127.0.0.1 only (the queue is not a
// public surface), restart unless-stopped, data on a named volume. Container and volume names are
// pi-dispatch-prefixed so compose's own `valkey`/`valkey-data` never collide with these.
const VALKEY_RUN = ["run", "-d", "--name", "pi-dispatch-valkey", "--restart", "unless-stopped", "-p", "127.0.0.1:6379:6379", "-v", "pi-dispatch-valkey-data:/data", "valkey/valkey:8", "valkey-server", "--appendonly", "yes"];

export async function runDoctor(env = process.env, deps = {}) {
	const {
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		spawn = nodeSpawn,
		probeValkey = defaultProbeValkey,
		fileExists = existsSync,
		nodeVersion = process.versions.node,
		// --fix (REQ-DEPLOYMENT-BOOTSTRAP): offer to run the exact fixes doctor already prints. The prompt
		// is injectable so tests drive consent hermetically; the default is a readline y/N that answers No
		// on empty input AND on non-TTY stdin -- a piped or CI `doctor --fix` runs nothing from the prompt
		// tier, because nobody was at the keyboard to consent.
		fix = false,
		promptFn = defaultPromptFn,
		// fs seams for the fixActions, injectable for the same hermetic-test reason as fileExists.
		mkdir = mkdirSync,
		chmod = chmodSync,
		rm = rmSync,
		// The operator's pi setup, compared against the staged overlay (issue #102). A seam because the
		// default is a real path in the developer's home directory and the host comparison may spawn their
		// package manager -- neither belongs in a unit test, and "no network, no Docker" is the same rule.
		agentDir = agentDirFrom(env),
	} = deps;
	const seams = { cwd, out, spawn, probeValkey, fileExists, nodeVersion, mkdir, chmod, rm, agentDir };

	let checks = await collectChecks(env, seams);
	let failed = render(checks, out);

	if (fix) {
		const ran = await applyFixes(checks, seams, promptFn);
		if (ran > 0) {
			// Converge-to-green: the probes are idempotent and cheap, so ONE full re-collect answers "did
			// the fixes take" without bookkeeping about which probe fed which check. At most once,
			// structurally -- the re-check never re-enters the fix pass, so a fix that did not take is
			// reported still-failing rather than retried forever.
			checks = await collectChecks(env, seams);
			const passing = checks.filter((c) => c.ok).length;
			out(`\nre-check after fixes: ${passing} of ${checks.length} checks pass\n`);
			for (const c of checks.filter((c) => !c.ok)) {
				out(`${c.warn ? "⚠" : "✗"} ${c.label}\n    → ${c.fix}\n`);
			}
			// Recomputed with the SAME failed/ok logic as the first pass (warn-not-fail): --fix changes
			// what doctor does, never how it judges. A converged run exits 0 because the checks pass now,
			// not because attempting fixes earns credit.
			failed = checks.some((c) => !c.ok && !c.warn);
		}
	}

	out(failed ? "\ndoctor: some checks failed — fix the above, then re-run.\n" : "\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n");
	return failed ? 1 : 0;
}

/** The ✓/⚠/✗ lines plus each failure's fix, exactly as doctor has always printed them. Returns whether
 *  any HARD check failed (a ⚠ never fails doctor). */
function render(checks, out) {
	let failed = false;
	for (const c of checks) {
		out(`${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.label}\n`);
		if (!c.ok) {
			out(`    → ${c.fix}\n`);
			if (!c.warn) failed = true;
		}
	}
	return failed;
}

/**
 * The --fix pass (REQ-DEPLOYMENT-BOOTSTRAP): walk the rendered checks IN ORDER and act on each failing one
 * that carries a fixAction. Returns how many fixes actually RAN -- a declined offer counts for nothing, so
 * a decline-everything run re-checks nothing and ends exactly like a fix-less one.
 */
async function applyFixes(checks, seams, promptFn) {
	let ran = 0;
	for (const c of checks) {
		if (c.ok || !c.fixAction) continue;
		const fa = c.fixAction;
		if (fa.tier === "prompt") {
			// The exact command first, then consent, default No. The same philosophy that runs jobs with
			// --pull=never holds here: nothing is fetched or started implicitly -- the y keypress IS the
			// operator running the command themselves, and doctor only saves the retyping after it.
			seams.out(`\nfix available: ${c.label}\n    $ ${fa.describe}\n`);
			if (!(await promptFn("run this? [y/N] "))) {
				seams.out(`skipped: ${c.label}\n`);
				continue;
			}
		}
		ran++;
		let res;
		try {
			res = await fa.run(seams);
		} catch (e) {
			res = { ok: false, note: e?.message ?? String(e) };
		}
		seams.out(`${res.ok ? "fixed" : "fix failed"}: ${c.label}${res.note ? ` — ${res.note}` : ""}\n`);
	}
	return ran;
}

/**
 * The default --fix consent prompt: y/N over readline, No unless the operator typed y/yes. Two refusals
 * are load-bearing: EMPTY input is No (plain enter must never consent), and NON-TTY stdin is No without
 * reading at all -- a piped or CI `doctor --fix` has nobody at the keyboard, so the prompt tier must
 * execute nothing there. Streams are injectable and the function exported so tests exercise both refusals
 * without owning the process's real stdin.
 */
export async function defaultPromptFn(question, { input = process.stdin, output = process.stdout } = {}) {
	if (!input.isTTY) return false;
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input, output });
	try {
		const answer = (await rl.question(question)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

/**
 * Run every probe and return the check list without rendering -- runDoctor renders it, and under --fix
 * collects it a second time for the converge re-check. Exported for the never-tier doctrine pin in the
 * tests (githubProtectionPreflight's precedent): the test walks the returned array and fails on any check
 * that grows a `fixAction` outside the allowed set, so the never tier stays a tested contract rather than
 * a comment.
 */
export async function collectChecks(env, seams) {
	const { cwd, spawn, probeValkey, fileExists, nodeVersion, agentDir = agentDirFrom(env) } = seams;

	const jobImage = env.PI_JOB_IMAGE ?? "pi-job:latest";
	const valkeyUrl = env.VALKEY_URL ?? "redis://127.0.0.1:6379";
	const provider = env.PI_PROVIDER ?? "anthropic";

	const checks = [];
	checks.push(nodeCheck(nodeVersion));

	checks.push({
		ok: fileExists(join(cwd, ".env")),
		warn: true, // advisory: env may be supplied by a service manager instead of a file
		label: ".env present",
		fix: "run `pi-dispatch init` to scaffold one (or supply env via your service manager)",
		// `fixAction` -- what `doctor --fix` may offer for a failing check (REQ-DEPLOYMENT-BOOTSTRAP):
		// { tier: "silent"|"prompt", describe: <the exact command>, run(seams) }. Silent runs unprompted
		// and is reported after; ONLY two fixes qualify, because in both the operator already made the
		// decision and only the mechanical remainder is left: (1) THIS one, delegating absent config files
		// to init, which is create-only by contract (init.mjs header) and so can overwrite nothing; and
		// (2) mkdir -p + chmod 700 of a directory an env var already names (the session store, below).
		// Prompt shows the exact command and defaults to No. EVERY other check deliberately carries no
		// fixAction -- the never tier: doctor never rewrites malformed JSON, never touches triggers or
		// pause-windows CONTENT, never guesses a semantic env value (PI_GLOBAL_ALLOW_EXTENSIONS and kin),
		// never touches branch protection, and never pulls a trigger-named run.image -- each custom image
		// is a per-flow trust posture the operator chose, so only the deployment's OWN default image ever
		// gains an offer. Fail loud and let the operator decide; the plain fix line still prints as before.
		fixAction: {
			tier: "silent",
			describe: "pi-dispatch init",
			run: async ({ out }) => {
				// Lazy import: a doctor run without --fix (or without this failure) never loads init.
				const { runInit } = await import("./init.mjs");
				const code = runInit(cwd, { out });
				return { ok: code === 0, note: "scaffolded by `pi-dispatch init` (create-only: existing files were kept)" };
			},
		},
	});

	const dockerCode = await runCmd(spawn, "docker", ["info"]);
	checks.push({
		ok: dockerCode === 0,
		label: "Docker daemon reachable",
		fix: dockerCode === null ? "install Docker — `docker` was not found on PATH" : "start Docker (the daemon is not responding)",
	});

	// Read once, used twice, so the triggers file is parsed a single time: `images` drives the per-trigger
	// image checks just below, and `optingOut`/`requiring` colour the staged-packages lines further down.
	// `optingOut` counts the only value that withholds the staged set; `requiring` counts an explicit
	// run.packages: true, which arms nothing any more but is still an operator statement of intent.
	const { requiring, optingOut, resuming, replicating, instructing, commands, images, skillsDirs, forges, repositories, flows } = readTriggerFacts(env, fileExists, cwd);

	// Only meaningful if docker itself responds; otherwise the image check is noise on top of a down daemon.
	const imageCode = dockerCode === 0 ? await runCmd(spawn, "docker", ["image", "inspect", jobImage]) : null;
	checks.push({
		ok: imageCode === 0,
		label: `Job image present (${jobImage})`,
		fix: "docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest  (or build image/Dockerfile)",
		// Prompt tier, and ONLY for the deployment default: a PI_JOB_IMAGE the operator overrode is a trust
		// choice this command cannot honestly satisfy (pulling ghcr's pi-job would not make THEIR image
		// exist), so an overridden name keeps the plain fix line -- the same never-tier reasoning as the
		// trigger-named run.image checks below. Jobs run with --pull=never and that stays true: the y
		// keypress IS the operator pulling the repo's own image themselves.
		...(jobImage === "pi-job:latest"
			? {
					fixAction: {
						tier: "prompt",
						describe: "docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest",
						run: async ({ spawn }) => {
							if ((await runCmd(spawn, "docker", ["pull", "ghcr.io/edgehero/pi-job:latest"])) !== 0) return { ok: false, note: "docker pull failed" };
							if ((await runCmd(spawn, "docker", ["tag", "ghcr.io/edgehero/pi-job:latest", "pi-job:latest"])) !== 0) return { ok: false, note: "docker tag failed" };
							return { ok: true };
						},
					},
				}
			: {}),
	});

	// REQ-PER-TRIGGER-SKILLS (issue #60). Every distinct `run.skillsDir`, checked BEFORE anything fires,
	// because the worker's own gate for these refuses at job time -- correct, but at 03:00 in a log nobody
	// is reading. A deployment naming none adds no lines at all, so its output is byte-identical.
	for (const dir of skillsDirs) {
		const present = dirExists(dir);
		checks.push({
			ok: present,
			label: `Trigger skills dir present (${dir})`,
			fix: `create ${dir} with one <name>/SKILL.md per skill, or drop run.skillsDir from that trigger -- every job of it refuses pre-spend while the path is absent`,
		});
		if (!present) continue;
		// A dry run of the real copier: same walker, same caps, same lstat symlink rule, into a throwaway
		// destination. Anything it would refuse at job time is reported here instead, in the operator's own
		// terminal, with the reason the job would have carried.
		const probe = probeSkillsDir(dir);
		if (probe.refused) {
			checks.push({
				ok: false,
				label: `Trigger skills dir is usable (${dir})`,
				fix: probeFix(probe.refused, dir),
			});
			continue;
		}
		checks.push({ ok: true, label: `Trigger skills dir holds ${probe.dirs} skill(s), ${probe.files} file(s)` });
		if (probe.skipped.symlinks > 0) {
			checks.push({
				ok: true,
				warn: true,
				label: `${probe.skipped.symlinks} entry(ies) under ${dir} are symlinks and are SKIPPED`,
				fix: "the copier never follows a link (a link out of the tree would put a host file in a job container); replace them with real files if the jobs need them",
			});
		}
		// Gap 5 of issue #60, and the one an operator cannot discover any other way: the ai-trigger gate
		// reads the repo's committed .pi/skills at the pinned sha, so an injected SKILL.md carrying the
		// opt-in is never consulted. Without this line the operator writes it and nothing honours it.
		const chainable = aiTriggerNames(dir);
		if (chainable.length > 0) {
			checks.push({
				ok: true,
				warn: true,
				label: `${chainable.length} injected skill(s) under ${dir} set ai-trigger: allow, which is NEVER read`,
				fix: "injected skills are trigger-reachable but not AI-reachable: the gate reads the target repo's committed .pi/skills at the pinned sha, so chain and dispatch_run requests for these flows are refused. Commit the flow to the repo if a model must be able to start it",
			});
		}
	}

	// REQ-PER-TRIGGER-SKILLS (issue #189). One line per distinct (flow, folder, skillsDir, packages)
	// question: does the flow this trigger names resolve in ANY tier this host can see? Probed in the
	// loader's own precedence order (repo > injected > overlay > staged packages), first hit wins the
	// line. ⚠ and NEVER ✗ when nothing resolves -- a forge trigger's repo is not on this host and
	// mid-setup is legal -- and no fixAction (triggers content is the never tier). The runner's
	// flow_not_loaded line is the exact, in-container half of the same answer
	// (DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS): these probes read dir names, and a frontmatter
	// `name:` rename is invisible to them, so a ⚠ here can be wrong in only the loud direction.
	// A deployment with no triggers adds no lines at all, so its output is byte-identical.
	if (flows.length > 0) {
		// One stage read for the whole run; each tuple's staged probe is a lookup on its result.
		const staged = readStagedSkills({ globalPiDir: env.PI_GLOBAL_PI_DIR, readFile: (p) => readFileSync(p, "utf8"), fileExists });
		const groups = new Map();
		for (const f of flows) {
			const key = JSON.stringify([f.flow, f.folder, f.skillsDir, f.packages]);
			if (!groups.has(key)) groups.set(key, { ...f, labels: [] });
			groups.get(key).labels.push(f.label);
		}
		for (const g of groups.values()) {
			const at = g.labels.join(", ");
			// The charset pre-check doubles as the interpolation guard for the git probe below, and it is
			// a finding of its own: a name the skill charset refuses can never materialise in ANY tier
			// (materialize and copy-tree enforce the same RE on the way in).
			if (!SKILL_NAME_RE.test(g.flow)) {
				checks.push({
					ok: false,
					warn: true,
					label: `Trigger flow ${JSON.stringify(g.flow)} fails the skill name charset (${at})`,
					fix: "a flow name must match the skill charset (lowercase alphanumerics, - and _, 64 max), or no tier can ever hold it -- fix run.flow",
				});
				continue;
			}
			let resolved = null;
			const checked = [];
			const unknown = [];
			if (g.folder) {
				const state = await repoFlowAtHead(spawn, g.folder, g.flow);
				if (state === "present") resolved = `repo .pi/skills at HEAD of ${g.folder}`;
				else if (state === "absent") checked.push("repo .pi/skills at HEAD");
				else unknown.push(`repo (${g.folder} is not readable as a git repo here)`);
			} else {
				unknown.push("repo (a forge clone, not on this host)");
			}
			if (!resolved && g.skillsDir) {
				if (fileExists(join(g.skillsDir, g.flow, "SKILL.md"))) resolved = `injected run.skillsDir ${g.skillsDir}`;
				else checked.push("injected run.skillsDir");
			}
			if (!resolved && env.PI_GLOBAL_PI_DIR) {
				if (fileExists(join(env.PI_GLOBAL_PI_DIR, "skills", g.flow, "SKILL.md"))) resolved = "the overlay skills/";
				else checked.push("overlay skills/");
			}
			if (!resolved) {
				if (!g.packages) {
					checked.push("staged packages (withheld: run.packages false)");
				} else {
					const hit = staged.skills.find((s) => s.name === g.flow);
					if (hit) resolved = `staged package ${hit.package}`;
					else if (staged.unenumerable.length > 0) unknown.push(`staged package(s) ${staged.unenumerable.join(", ")} (manifest patterns, not enumerable here)`);
					else checked.push("staged packages");
				}
			}
			if (resolved) {
				checks.push({ ok: true, label: `Trigger flow "${g.flow}" resolves (${at}: ${resolved})` });
			} else {
				checks.push({
					ok: false,
					warn: true,
					label: `Trigger flow "${g.flow}" resolves in NO tier visible here (${at})`,
					fix: `checked: ${checked.join(", ") || "nothing checkable"}${unknown.length > 0 ? `; not checkable here: ${unknown.join(", ")}` : ""} -- commit .pi/skills/${g.flow}/SKILL.md, add the skill to run.skillsDir or the overlay skills/, or stage a package shipping it; a job of this trigger runs without the flow it names (the runner logs flow_not_loaded) and still exits 0`,
				});
			}
		}
	}

	// run.command triggers (issue #189): ONE advisory line, deliberately WITHOUT the per-tier probes the
	// flow block above runs. A command is registered by extension CODE at pi startup -- repo .pi/, the
	// overlay and staged packages all contribute, and none is enumerable host-side without executing the
	// extension, which doctor must never do. The honest line names where the real check lives instead;
	// unlike a missing flow, the failure there is LOUD (a refusal, not a clean exit 0), which is why this
	// is advisory and carries no fixAction (triggers content is the never tier). A deployment with no
	// command triggers adds no line at all, so its output is byte-identical.
	if (commands > 0) {
		checks.push({ ok: true, label: `${commands} command trigger(s): a command is only verifiable in-container -- the runner refuses an unregistered one pre-spend (command-unregistered)` });
	}

	// Issue #41: every DISTINCT image a trigger names in run.image, minus the deployment default already
	// checked above. Two silent-failure modes, and both used to be impossible because there was one image.
	//   1. the image was never built -- a job that refuses pre-spend at 03:00 in a log nobody is reading, and
	//      with --pull=never nothing will fetch it either, so this line is the only warning that arrives first.
	//   2. the image is present but is not a pi-job image. An entrypoint that is not the runner either exits
	//      126/127 or, worse, runs whatever it does have and exits 0 -- a job the queue records as COMPLETED
	//      that never started the agent. Warn, never fail: an operator MAY legitimately ship a wrapper
	//      entrypoint that execs the runner, and a ✗ here is reserved for certainties.
	// A deployment with no run.image anywhere adds no lines at all, so its output is byte-identical.
	for (const img of dockerCode === 0 ? images.filter((i) => i !== jobImage) : []) {
		const code = await runCmd(spawn, "docker", ["image", "inspect", img]);
		checks.push({
			ok: code === 0,
			label: `Trigger job image present (${img})`,
			fix: `docker pull ${img} (or build it) -- a trigger names it in run.image, and jobs run with --pull=never, so the worker never fetches it at job time`,
		});
		if (code !== 0) continue;
		const entry = await runCmdCapture(spawn, "docker", ["image", "inspect", "--format={{json .Config.Entrypoint}}", img]);
		if (entry.code === 0 && !entry.output.includes("entrypoint.sh")) {
			checks.push({
				ok: false,
				warn: true,
				label: `${img} does not appear to carry the pi-dispatch runner entrypoint`,
				fix: "build your job image FROM this repo's image/Dockerfile so it keeps /entrypoint.sh -- an image without the runner can exit 0 without ever starting the agent, and the queue records that as success (docs/job-image.md)",
			});
		}
	}

	// The receiver itself, when the triggers file names ANY forge (issue #80). Only forge deliveries need
	// the receiver at all, so a cron/local-only deployment gets no receiver noise here. WARNS rather than
	// fails, same doctrine as the gitlab block below: a deployment can legitimately be mid-setup (or run
	// the receiver on another host with its own env), and doctor's job is to say what will not work, not
	// to refuse.
	if (forges.length > 0) {
		// Presence only, value never read out (secrets-and-pii) -- without it the receiver refuses to boot,
		// because a webhook it cannot verify is a forgeable paid-agent trigger (CONST-HMAC-OVER-RAW-BODY).
		const webhookSecret = env.WEBHOOK_SECRET;
		if (typeof webhookSecret !== "string" || webhookSecret.trim() === "") {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has ${forges.join("/")} triggers but WEBHOOK_SECRET is unset -- the receiver will refuse to start`,
				fix: "generate one (`openssl rand -hex 32`) and set WEBHOOK_SECRET in .env -- `pi-dispatch-receiver` verifies every delivery's signature against it and refuses to boot without it",
			});
		} else {
			checks.push({ ok: true, label: "WEBHOOK_SECRET set -- the receiver (`pi-dispatch-receiver`) can verify deliveries" });
		}
		// Validated only WHEN SET: unset (or empty) means the loader's own default of 3000, which needs no
		// line. The malformed value IS echoed -- a port is not a secret, and naming the shape it actually
		// has is what makes the warn actionable. Mirrors `positiveInt` (worker config.mjs) exactly, because
		// that is the parse the receiver refuses to boot on.
		const port = env.RECEIVER_PORT;
		if (port !== undefined && port !== "") {
			const n = Number.parseInt(port, 10);
			if (!Number.isInteger(n) || n < 1 || String(n) !== String(port).trim()) {
				checks.push({
					ok: false,
					warn: true,
					label: `RECEIVER_PORT is ${JSON.stringify(port)}, which is not a positive integer -- the receiver will refuse to start`,
					fix: "set RECEIVER_PORT to a TCP port number, or drop it for the default (3000)",
				});
			}
		}
	}

	// GitLab, when the triggers file names it. WARNS rather than fails, matching the github auth checks
	// below and for the same reason: a deployment can legitimately be mid-setup, and doctor's job is to say
	// what will not work, not to refuse.
	if (forges.includes("gitlab")) {
		const token = env.GITLAB_TOKEN;
		if (typeof token !== "string" || token.trim() === "") {
			checks.push({
				ok: false,
				warn: true,
				label: "triggers.json has gitlab triggers but GITLAB_TOKEN is unset",
				fix: "set GITLAB_TOKEN to a project or group access token with the `api` scope -- gitlab jobs cannot clone, comment, or resolve the actor's access level without it",
			});
		} else {
			checks.push({ ok: true, label: `gitlab triggers configured (${env.GITLAB_URL ?? "https://gitlab.com"})` });
			// The scope an operator cannot narrow. Said out loud because it is the one place GitLab is
			// weaker than the github App path and an operator should know which trade they made
			// (CONST-TOKEN-SCOPED-PER-JOB).
			checks.push({
				ok: true,
				warn: true,
				label: "a GitLab project access token needs the `api` scope to post notes, which grants full project API read/write",
				fix: "scope the token to ONE project and rotate it on a schedule -- GitLab offers no contents-vs-issues split, and no short-expiry equivalent of a GitHub App token",
			});
		}
		// The receiver-boot half (issue #80), mirrored from receiver/src/config.mjs loadGitLabConfig: once
		// ANY GITLAB_* variable is set, boot refuses without a chosen mode and a secret -- and with NONE
		// set there is no /gitlab route at all, so these triggers can never fire either way. The mode value
		// is echoed (it is a choice, not a secret); the secret is presence-only.
		const glMode = env.GITLAB_WEBHOOK_MODE;
		if (glMode !== "signature" && glMode !== "token") {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has gitlab triggers but GITLAB_WEBHOOK_MODE is ${glMode === undefined ? "unset" : JSON.stringify(glMode)} -- the receiver will refuse to start`,
				fix: 'set it to "signature" (HMAC, GitLab 19.0+) or "token" (X-Gitlab-Token, any version) -- deliberately undefaulted, which verification a deployment runs must be a thing somebody chose (.env.example, docs/gitlab.md)',
			});
		}
		if (typeof env.GITLAB_WEBHOOK_SECRET !== "string" || env.GITLAB_WEBHOOK_SECRET.trim() === "") {
			checks.push({
				ok: false,
				warn: true,
				label: "triggers.json has gitlab triggers but GITLAB_WEBHOOK_SECRET is unset -- the receiver cannot verify deliveries and will refuse to start",
				fix: "set GITLAB_WEBHOOK_SECRET in .env to the secret configured on the project webhook (.env.example, docs/gitlab.md)",
			});
		}
	}

	// Forgejo, when the triggers file names it (issue #80) -- the gitlab block's twin, and previously the
	// gap: a forgejo misconfiguration hard-failed at receiver boot with no preflight warning. The variable
	// set mirrors receiver/src/config.mjs loadForgejoConfig exactly (those three are what boot
	// hard-requires), so this warns about precisely what the receiver will refuse. Presence-only for all
	// three: FORGEJO_URL is no secret, but one rule for the set is one rule to audit.
	if (forges.includes("forgejo")) {
		const missing = ["FORGEJO_URL", "FORGEJO_WEBHOOK_SECRET", "FORGEJO_TOKEN"].filter((k) => typeof env[k] !== "string" || env[k].trim() === "");
		if (missing.length > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has forgejo triggers but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset -- the receiver will refuse to start (or serve no /forgejo endpoint at all)`,
				fix: "set them in .env (.env.example documents each; docs/forgejo.md walks the webhook setup); FORGEJO_BOT_ID is also needed when FORGEJO_TOKEN is repository-scoped -- a scoped token cannot call GET /user to identify itself",
			});
		} else {
			checks.push({ ok: true, label: `forgejo triggers configured (${env.FORGEJO_URL})` });
		}
	}

	// Azure DevOps, when the triggers file names it (issue #80) -- same shape, mirrored from
	// receiver/src/config.mjs loadAzureConfig. AZURE_WEBHOOK_MODE gets its own line because it is
	// required-UNDEFAULTED: Azure offers no HMAC at all, so both modes are shared-secret compares, and
	// which header carries the secret must be a thing somebody decided. AZURE_WEBHOOK_HEADER joins the
	// required set only under mode=header, exactly as boot requires it.
	if (forges.includes("azure")) {
		const azMode = env.AZURE_WEBHOOK_MODE;
		const azModeOk = azMode === "basic" || azMode === "header";
		if (!azModeOk) {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has azure triggers but AZURE_WEBHOOK_MODE is ${azMode === undefined ? "unset" : JSON.stringify(azMode)} -- the receiver will refuse to start`,
				fix: 'set it to "basic" (HTTP Basic on the service hook) or "header" (a custom header) -- deliberately undefaulted, Azure offers no HMAC, so which shared-secret compare gates the endpoint must be a chosen thing (.env.example, docs/azure-devops.md)',
			});
		}
		const azRequired = ["AZURE_WEBHOOK_SECRET", "AZURE_TOKEN", "AZURE_ORG_URL", ...(azMode === "header" ? ["AZURE_WEBHOOK_HEADER"] : [])];
		const azMissing = azRequired.filter((k) => typeof env[k] !== "string" || env[k].trim() === "");
		if (azMissing.length > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has azure triggers but ${azMissing.join(", ")} ${azMissing.length === 1 ? "is" : "are"} unset -- the receiver will refuse to start (or serve no /azure endpoint at all)`,
				fix: "set them in .env (.env.example documents each; docs/azure-devops.md walks the service-hook setup)",
			});
		} else if (azModeOk) {
			checks.push({ ok: true, label: `azure triggers configured (${env.AZURE_ORG_URL})` });
		}
	}

	// REQ-BRANCH-PROTECTION-PRECONDITION, preflighted (issue #80). The worker refuses a forge-backed job
	// on an unprotected default branch BEFORE any spend -- correct, but that answer arrives at the first
	// paid trigger, as a refusal comment a requester is already waiting on. Doctor asks the same question
	// READ-ONLY at setup time, for each github repo the triggers file NAMES. Warn, never fail: the
	// worker's own gate stays the enforcement, this is the early copy of its answer.
	if (forges.includes("github")) {
		if (repositories.length === 0) {
			// A github label/comment trigger takes its repository from each delivery's payload, and the
			// shared schema admits `run.repository` only on azure triggers today (triggers.mjs,
			// validateRepository) -- so there is nothing here to ask GitHub about. Said in ONE line so a
			// green doctor cannot read as "this REQ was preflighted": it is enforced per job, just not
			// checkable from here.
			checks.push({
				ok: true,
				label: "github triggers take their repository from each delivery -- branch protection cannot be preflighted per repo here, and is enforced per job before any spend (REQ-BRANCH-PROTECTION-PRECONDITION)",
			});
		} else {
			checks.push(...(await githubProtectionPreflight(spawn, repositories)));
		}
	}

	// The default source `gh` mints job tokens from the operator's gh login, so the FULL-scope login token
	// reaches every token-carrying job container — the opposite of the App path's per-repo short-lived
	// tokens (CONST-TOKEN-SCOPED-PER-JOB). Both checks below warn, never fail: a local-only deployment with
	// the default source is valid, for the same reason the worker's own auth at start is best-effort.
	const ghSource = env.GITHUB_AUTH_SOURCE ?? "gh"; // config.mjs's own default, read directly — no loadConfig
	if (ghSource === "gh") {
		// gh writes `auth status` to stdout or stderr depending on version — capture both combined.
		const status = await runCmdCapture(spawn, "gh", ["auth", "status"]);
		if (status.code === 0) {
			const scopes = parseGhTokenScopes(status.output);
			const broad = (scopes ?? []).filter((s) => BROAD_SCOPES.includes(s));
			checks.push({
				ok: false,
				warn: true,
				label: `GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (${
					scopes ? `scopes: ${scopes.join(", ")}` : "scopes not reported (fine-grained token)"
				})`,
				fix:
					(broad.length > 0 ? `this token carries broad scopes (${broad.join(", ")}) -- ` : "") +
					"use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			});
		} else {
			checks.push({
				ok: false,
				warn: true,
				label: "GITHUB_AUTH_SOURCE is gh but `gh auth status` failed",
				fix: "run `gh auth login` (or switch GITHUB_AUTH_SOURCE) -- github jobs and run.github cron triggers will refuse to run",
			});
		}
	}

	// GITHUB_AUTH_SOURCE=app: completeness of the credential triple loadGitHubAuth hard-requires
	// (config.mjs), preflighted here so a half-finished App setup surfaces as doctor lines instead of a
	// boot refusal. WARN, never fail, same doctrine as the rest of the github block: a deployment can
	// legitimately be mid-setup. The private key gets a hygiene pass on top — presence, POSIX mode, and
	// a first-bytes PEM sniff — but its CONTENTS never reach output: only the leading bytes are read
	// (never the whole key into memory), and nothing from the file is ever echoed. Every fix line points
	// at `pi-dispatch setup github`, which mints all three values and writes the PEM 0600 in one pass.
	if (ghSource === "app") {
		const setupFix = "run `pi-dispatch setup github` -- it mints the App, writes these .env lines, and lands the key mode 0600";
		const numeric = (v) => typeof v === "string" && /^\d+$/.test(v.trim());
		for (const name of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID"]) {
			checks.push({
				ok: numeric(env[name]),
				warn: true,
				label: numeric(env[name])
					? `${name} set (${env[name].trim()})`
					: `GITHUB_AUTH_SOURCE=app but ${name} is ${env[name] ? `not numeric (${JSON.stringify(env[name])})` : "unset"} -- github jobs cannot mint tokens`,
				fix: setupFix,
			});
		}
		const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
		if (!keyPath) {
			checks.push({ ok: false, warn: true, label: "GITHUB_AUTH_SOURCE=app but GITHUB_APP_PRIVATE_KEY_PATH is unset -- the worker will refuse to boot", fix: setupFix });
		} else if (!fileExists(keyPath)) {
			checks.push({ ok: false, warn: true, label: `GITHUB_APP_PRIVATE_KEY_PATH does not exist (${keyPath})`, fix: setupFix });
		} else {
			checks.push({ ok: true, label: `GitHub App private key present (${keyPath})` });
			// POSIX mode only -- on win32 stat modes are synthetic (0666-ish for everything), so a warn
			// there would fire on every healthy deployment and teach operators to ignore it.
			if (process.platform !== "win32") {
				try {
					const loose = statSync(keyPath).mode & 0o077;
					if (loose !== 0) {
						checks.push({
							ok: false,
							warn: true,
							label: `the App private key at ${keyPath} is group/world-readable`,
							fix: `chmod 600 ${keyPath} -- any local user can read the App's signing key right now (\`pi-dispatch setup github\` writes it 0600)`,
						});
					}
				} catch {
					// stat raced a deletion or an exotic fs: the presence line above already covered existence.
				}
			}
			// First bytes only: enough to see "-----BEGIN", never the key material, and never echoed.
			try {
				const fd = openSync(keyPath, "r");
				const head = Buffer.alloc(16);
				let read = 0;
				try {
					read = readSync(fd, head, 0, head.length, 0);
				} finally {
					closeSync(fd);
				}
				if (!head.toString("utf8", 0, read).startsWith("-----BEGIN")) {
					checks.push({
						ok: false,
						warn: true,
						label: `the file at GITHUB_APP_PRIVATE_KEY_PATH does not look like a PEM (first line is not "-----BEGIN ...") -- contents not shown`,
						fix: setupFix,
					});
				}
			} catch {
				checks.push({ ok: false, warn: true, label: `the App private key at ${keyPath} exists but is not readable by this user`, fix: setupFix });
			}
			// Mode 0600 protects the key from other users on this host; it does nothing once the file is in
			// a commit. `setup github` writes the key into the DEPLOYMENT FOLDER, and a deployment folder is
			// very often a checkout -- so the last thing between an App signing key and a public repository
			// can be one `git add -A`. This repo's own .gitignore covers *.pem; the operator's may not, and
			// a key they renamed or brought themselves is the same accident.
			//
			// Exit 1 is the ONLY case that warns: git says "this is a work tree, and that path is not
			// ignored". 0 means covered, 128 means no work tree at all, and null means git could not be
			// launched. Every one of those is silence, because a check nobody can silence must never cry
			// wolf -- the cost of a missed warning here is one operator reading the doc, and the cost of a
			// false one is every operator learning to scroll past doctor.
			const ignoreCode = await runCmd(spawn, "git", [...GIT_READ_FLAGS, "-C", dirname(keyPath), "check-ignore", "-q", keyPath]);
			if (ignoreCode === 1) {
				checks.push({
					ok: false,
					warn: true,
					label: `the App private key at ${keyPath} is inside a git work tree that does not ignore it`,
					fix: `move it outside that repo, or ignore it there (\`*.pem\`) -- one \`git add -A\` commits the App's signing key, which can mint a token for every repository the App is installed on, and mode 0600 does not survive a commit`,
				});
			}
		}
	}

	// Preflight gh INSIDE the job image: a token that works host-side but not in-container (no egress from
	// containers, stale image) fails jobs mid-run, not at submit. Only meaningful when docker and the image
	// are green; otherwise it is noise on top of the failures already reported above.
	if (dockerCode === 0 && imageCode === 0) {
		if (ghSource === "app") {
			checks.push({ ok: true, label: "in-image gh auth: skipped (GITHUB_AUTH_SOURCE=app mints per-job)" });
		} else {
			let token = "";
			if (ghSource === "gh") {
				const minted = await runCmdCapture(spawn, "gh", ["auth", "token"]);
				if (minted.code === 0) token = minted.output.trim();
				// mint failed → skip: the status check above already warned that gh auth is broken
			} else if (ghSource === "pat") {
				const patVar = env.GITHUB_PAT_VAR ?? "GITHUB_PAT"; // config.mjs's patVar default, read directly
				token = (env[patVar] ?? "").trim(); // absent → skip; loadConfig fails loud at worker boot anyway
			}
			if (token) {
				// Value-less `-e` flags: docker forwards GH_TOKEN/GITHUB_TOKEN from the spawn env, so the
				// token value never enters argv (visible in `ps`) and never reaches doctor's output.
				const probe = await runCmdCapture(
					spawn,
					"docker",
					["run", "--rm", "--pull=never", "-e", "GH_TOKEN", "-e", "GITHUB_TOKEN", "--entrypoint", "gh", jobImage, "auth", "status"],
					{ env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: token } },
				);
				checks.push({
					ok: probe.code === 0,
					warn: true,
					label:
						probe.code === 0
							? `gh authenticates inside the job image (${jobImage})`
							: `gh cannot authenticate inside the job image (${jobImage})`,
					fix: "check network egress from containers or rebuild/pull the job image -- jobs that use gh will fail mid-run",
				});
			}
		}
	}

	checks.push({
		ok: await probeValkey(valkeyUrl),
		label: `Valkey reachable (${valkeyUrl})`,
		fix: "docker compose -f deploy/docker-compose.yml up -d",
		// Prompt tier, and only for a LOOPBACK url (the shipped default): starting a local container cannot
		// make a remote VALKEY_URL reachable, so a pointed-elsewhere deployment keeps the plain fix line
		// rather than an offer that would mask the real problem. The argv mirrors the compose file's
		// semantics exactly (VALKEY_RUN above).
		...(/^redis:\/\/(127\.0\.0\.1|localhost)(:6379)?\/?$/.test(valkeyUrl)
			? {
					fixAction: {
						tier: "prompt",
						describe: `docker ${VALKEY_RUN.join(" ")}`,
						run: async ({ spawn }) =>
							(await runCmd(spawn, "docker", VALKEY_RUN)) === 0
								? { ok: true }
								: { ok: false, note: "docker run failed (is a container named pi-dispatch-valkey already present? `docker start pi-dispatch-valkey`)" },
					},
				}
			: {}),
	});

	const keys = PROVIDER_KEYS[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
	let keyOk = keys.some((k) => (env[k] ?? "").trim().length > 0);
	let keyNote = "";
	// The key may come from pi's auth.json when the env has none (ON by default; PI_AUTH_FROM_PI=0 forces
	// env-only) — so don't falsely report it missing.
	const authFromPi = env.PI_AUTH_FROM_PI !== "0";
	if (!keyOk && authFromPi) {
		const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		try {
			const cred = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))?.[provider];
			if (cred?.type === "api_key" && cred.key) {
				keyOk = true;
				keyNote = " — from pi auth.json";
			} else if (cred?.type === "oauth") {
				keyNote = " — pi login is OAuth/subscription: not usable for an unattended service, configure an API key";
			}
		} catch {}
	}
	checks.push({
		ok: keyOk,
		label: `Provider key set (${provider}: ${keys.join(" or ")})${keyNote}`,
		fix: authFromPi ? `run \`pi login\` with an API key for ${provider}, or set ${keys[0]} in .env` : `set ${keys[0]} in .env`,
	});


	// REQ-GLOBAL-PI-OVERLAY: read the extensions opt-out through the WORKER's own parser, so doctor reports
	// the exact posture the worker will boot with and refuses the exact values it refuses. Checked with or
	// without an overlay configured, because a malformed knob stops boot either way -- and a `false` an
	// operator wrote believing it disabled their extensions is precisely the value they need told about.
	let extensionsEnabled = true;
	let extensionsInvalid = false;
	try {
		extensionsEnabled = globalExtensionsEnabled(env);
	} catch {
		extensionsInvalid = true;
		checks.push({
			ok: false,
			label: `PI_GLOBAL_ALLOW_EXTENSIONS is ${JSON.stringify(env.PI_GLOBAL_ALLOW_EXTENSIONS)}, which is neither on nor off`,
			fix: 'set it to exactly "0" to disable the overlay\'s extensions, or leave it unset to load them -- the worker refuses to boot on any other value',
		});
	}

	// Global pi overlay (REQ-GLOBAL-PI-OVERLAY), only when configured. The overlay is mounted :ro into an
	// adversarial-input container, so the load-bearing checks are that it holds NO credential.
	const overlay = env.PI_GLOBAL_PI_DIR;
	if (overlay) {
		const dirOk = fileExists(overlay);
		checks.push({ ok: dirOk, label: `Global overlay dir exists (${overlay})`, fix: "run `pi-dispatch import-pi`, or fix PI_GLOBAL_PI_DIR" });
		if (dirOk) {
			const overlayAuth = join(overlay, "auth.json");
			checks.push({
				ok: !fileExists(overlayAuth),
				label: "Overlay is credential-free (no auth.json)",
				fix: "delete auth.json from the overlay — the provider key belongs in env, never a mounted file",
				// Prompt, not silent, even though deleting it is always right for the OVERLAY: the file may
				// be the operator's only copy of a credential they meant to keep elsewhere, and doctor
				// deleting an operator's file unasked is a line not worth crossing for one saved keypress.
				fixAction: {
					tier: "prompt",
					describe: `rm ${overlayAuth}`,
					run: async ({ rm }) => {
						rm(overlayAuth);
						return { ok: true };
					},
				},
			});
			const modelsPath = join(overlay, "models.json");
			let modelsOk = true;
			let modelsFix = "";
			if (fileExists(modelsPath)) {
				try {
					const leak = findLiteralSecret(JSON.parse(readFileSync(modelsPath, "utf8")));
					if (leak) {
						modelsOk = false;
						modelsFix = `literal secret at ${leak} — move it to env/auth.json or a "$VAR" reference`;
					}
				} catch {
					modelsOk = false;
					modelsFix = "overlay models.json is not valid JSON";
				}
			}
			checks.push({ ok: modelsOk, label: "Overlay models.json is credential-free", fix: modelsFix });
			// Staged extensions load unless the operator opted out, so this pair reports what WILL run, not
			// what is switched on. The ⚠ sits on the loading case: it is the one where code the operator may
			// have staged months ago is executing against adversarial input right now. It stays a warning and
			// never a failure -- a vetted overlay that loads is the intended deployment, not a fault.
			// Suppressed when the knob is malformed: the ✗ above already says the worker will not boot, and a
			// second line guessing which way it would have resolved would be worse than silence.
			if (fileExists(join(overlay, "extensions")) && !extensionsInvalid) {
				if (extensionsEnabled) {
					checks.push({
						ok: false,
						warn: true,
						label: "Overlay extensions LOAD in every job (PI_GLOBAL_ALLOW_EXTENSIONS is not 0)",
						fix: "they run code against adversarial input with open egress — vet each; set PI_GLOBAL_ALLOW_EXTENSIONS=0 in .env to disable them",
					});
				} else {
					checks.push({ ok: true, label: "Overlay extensions present but disabled (PI_GLOBAL_ALLOW_EXTENSIONS=0)" });
				}
			}

			// Staged pi packages (REQ-GLOBAL-PI-OVERLAY): pinned third-party code the operator staged with
			// `import-pi --with-packages`, loaded by every job whose trigger did not set `run.packages: false`.
			// Keyed on the dir the same way the extensions pair above is, so a deployment that stages none
			// prints nothing here.
			const packagesDir = join(overlay, PACKAGES_SUBDIR);
			if (fileExists(packagesDir)) {
				// The restage offer shared by the two staleness checks below (prompt tier: it fetches and
				// runs npm on this host). A child process through the injected spawn rather than an
				// in-process call, so import-pi's own gates run unmodified -- the literal-secret abort, the
				// admin-extension block, the printed-names vetting -- and its output is forwarded so the
				// operator still reads the names of exactly what will load into their job containers.
				//
				// `--no-host-packages` is load-bearing (issue #102). Since discovery landed, a bare
				// `--with-packages` also stages whatever the operator installed in pi, and this is the ONE
				// path where staging happens without them typing the command. Accepting a repair prompt must
				// stay a repair: it restores what the overlay already had, it never performs a first-time
				// import of the operator's laptop into every job container. Importing is always something
				// they asked for.
				const restageFixAction = {
					tier: "prompt",
					describe: `pi-dispatch import-pi --with-packages --no-host-packages --to ${overlay}`,
					run: async ({ spawn, out }) => {
						const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
						// npm staging can be slow, so 10 minutes rather than runCmdCapture's default 30s.
						const res = await runCmdCapture(spawn, process.execPath, [cli, "import-pi", "--with-packages", "--no-host-packages", "--to", overlay], { env, cwd, timeoutMs: 600000 });
						if (res.output) out(res.output);
						return { ok: res.code === 0 };
					},
				};
				const manifest = readStageManifest({ globalPiDir: overlay, readFile: (p) => readFileSync(p, "utf8"), fileExists });
				if (!manifest) {
					checks.push({
						ok: false,
						label: `Staged packages manifest readable (${PACKAGES_SUBDIR}/packages.json)`,
						fix: "re-run `pi-dispatch import-pi --with-packages` -- without the manifest nothing knows what is staged, so no package is ever loaded",
						fixAction: restageFixAction,
					});
				} else {
					// A manifest entry whose dir is gone loads nothing, and pi reports no error for a package
					// it was never told about -- the stage is only as real as the dirs behind the names.
					const missing = manifest.packages.filter((p) => !fileExists(join(packagesDir, p.dir))).map((p) => p.name);
					checks.push({
						ok: missing.length === 0,
						label: `Staged packages present (${manifest.packages.map((p) => `${p.name}@${p.version}`).join(", ")})`,
						fix: `staged dir missing for ${missing.join(", ")} -- re-run \`pi-dispatch import-pi --with-packages\` to restage`,
						fixAction: restageFixAction,
					});
					// The admin extension's twin, and blocked for the same reason import-pi blocks that one.
					const admin = manifest.packages.filter((p) => ADMIN_RE.test(p.name) || ADMIN_RE.test(p.dir)).map((p) => p.name);
					if (admin.length > 0) {
						checks.push({
							ok: false,
							label: `Staged package looks like the dispatch admin (${admin.join(", ")})`,
							fix: "remove it from the overlay -- a package that can enqueue paid jobs from INSIDE a job container is a recursion vector",
						});
					}
					// There is no dormant state left to report: a staged, manifested package loads into every
					// job whose trigger did not opt out -- INCLUDING jobs no trigger file describes at all
					// (a matched webhook, `dispatch_run`, the CLI). So "staged" IS "loading", and the honest
					// line says so and names how much of the trigger file withholds it. Warn, never fail: this
					// is the intended posture, and it is stated so a forgotten stage cannot read as inert.
					// Sits inside the manifest branch because an unreadable manifest loads NOTHING -- the ✗
					// above is that case, and claiming these load there would be the opposite of the truth.
					checks.push({
						ok: false,
						warn: true,
						label: `Staged packages LOAD in every job (${optingOut} trigger(s) opt out with run.packages: false)`,
						fix: "they run third-party code against adversarial input with open egress -- vet each, keep every version exactly pinned, and set run.packages: false on any trigger that must not load them",
					});

					// A staged package whose --ignore-scripts build never ran (issue #102, comment 1). The
					// stager warns once, at stage time, and then nothing mentions it again -- so the symptom
					// is every job on that trigger failing INSIDE the container, after taking a daily-cap
					// slot. Warn rather than fail: a package may declare a build script and still work.
					const unbuilt = manifest.packages
						.map((p) => ({ name: p.name, scripts: buildScriptsOf(join(packagesDir, p.dir), fileExists) }))
						.filter((p) => p.scripts.length > 0);
					if (unbuilt.length > 0) {
						checks.push({
							ok: false,
							warn: true,
							label: `Staged package declares a build step that did NOT run (${unbuilt.map((p) => `${p.name}: ${p.scripts.join(", ")}`).join("; ")})`,
							fix: "staging is always --ignore-scripts, so such a package is staged INCOMPLETE and may fail at run time -- check it works in a job, or stage a prebuilt version",
						});
					}
				}
			} else if (requiring > 0) {
				// The silently-package-less job, and the one check the flip does NOT touch: `run.packages:
				// true` is no longer an arming switch, but it is still an operator asserting "this flow needs
				// the staged packages". Nothing staged means PI_PACKAGES is never emitted and the flow runs
				// WITHOUT the tools it was written for -- on a clean exit 0.
				checks.push({
					ok: false,
					label: `${requiring} trigger(s) require staged packages (run.packages: true) but nothing is staged in ${packagesDir}`,
					fix: "declare them in pi-packages.json and run `pi-dispatch import-pi --with-packages`, or drop run.packages from the trigger -- otherwise the flow runs without its tools and still exits 0",
				});
			}

			// Compare the operator's OWN pi setup against what is staged (issue #102). Until this landed,
			// doctor reported a healthy overlay while N host packages would never load in a job, and it had
			// every fact it needed to say so. All three are WARNINGS: a deployment may deliberately run a
			// narrower set than the operator's laptop, and that is a choice, not a fault.
			//
			// NONE of them carries a fixAction, and that is doctrine rather than omission. Now that
			// `--with-packages` discovers, an offered "restage for me" would stop meaning "restore what you
			// declared" and start meaning "import whatever is on your laptop into every job container". That
			// is a different consent class and it does not belong behind a y/N prompt.
			const staged = readStageManifest({ globalPiDir: overlay, readFile: (p) => readFileSync(p, "utf8"), fileExists });
			const stagedByName = new Map((staged?.packages ?? []).map((p) => [p.name, p]));
			const hostPi = await readHostPi({
				agentDir,
				fs: { existsSync: fileExists, readFileSync, readdirSync, statSync },
				// doctor's seam is `spawn`, host-pi's is an execFile-shaped call, so this adapts one to the
				// other rather than giving doctor a second process seam to inject in tests.
				exec: async (file, args) => {
					const res = await runCmdCapture(spawn, file, args, { env, cwd, timeoutMs: 15000 });
					if (res.code !== 0) throw new Error(`${file} exited ${res.code ?? "without a code"}`);
					return { stdout: res.output };
				},
				withPackages: true,
			});

			const unstaged = hostPi.packages.filter((p) => !p.skip && !stagedByName.has(p.name));
			if (unstaged.length > 0) {
				// The label names the path it enumerated. An operator whose package lives somewhere this did
				// not look needs to know WHERE it looked, or "auto-import is broken" is the only conclusion
				// available to them.
				checks.push({
					ok: false,
					warn: true,
					label: `${unstaged.length} package(s) in your pi setup are NOT staged (${unstaged.map((p) => `${p.name}@${p.version}`).join(", ")})`,
					fix: `re-run \`pi-dispatch import-pi --with-packages --to ${overlay}\` to stage them, or leave them out if this deployment runs a narrower set than your host`,
				});
			}

			// Version drift. Today nothing notices, and the symptom is a flow behaving differently in a job
			// than it does interactively, which is the hardest kind of difference to chase.
			const drifted = hostPi.packages.filter((p) => !p.skip && stagedByName.has(p.name) && stagedByName.get(p.name).version !== p.version);
			if (drifted.length > 0) {
				checks.push({
					ok: false,
					warn: true,
					label: `${drifted.length} staged package(s) differ from your pi setup (${drifted.map((p) => `${p.name}: overlay ${stagedByName.get(p.name).version}, host ${p.version}`).join("; ")})`,
					fix: "re-run `pi-dispatch import-pi --with-packages` to move the overlay to your host's versions, or pin the version you want in pi-packages.json (an explicit pin wins over discovery)",
				});
			}

			// Named rather than silent: a git-sourced host package cannot be expressed in pi-packages.json at
			// all (it validates an npm name plus an exact semver, and a ref is neither), so its absence would
			// otherwise be a mystery rather than a limitation.
			const gitSourced = hostPi.packages.filter((p) => p.kind === "git");
			if (gitSourced.length > 0) {
				checks.push({
					ok: false,
					warn: true,
					label: `${gitSourced.length} package(s) in your pi setup are git-sourced and cannot be staged (${gitSourced.map((p) => p.name).join(", ")})`,
					fix: "pi-packages.json pins an npm name plus an exact version, and a git ref is neither -- publish the package to a registry, or accept that jobs run without it",
				});
			}
		}
	} else if (requiring > 0) {
		// Same silent failure one level up: the staged set lives INSIDE the overlay, so no overlay means the
		// packages are not mounted at all, however carefully they were staged.
		checks.push({
			ok: false,
			label: `${requiring} trigger(s) require staged packages (run.packages: true) but PI_GLOBAL_PI_DIR is unset`,
			fix: "set PI_GLOBAL_PI_DIR -- staged packages live inside the overlay and are mounted with it, so with no overlay there is nothing to load",
		});
	}

	// REQ-RESUMABLE-SESSION. Only reported when a trigger actually asked for it: a deployment that does
	// not use resume should not be told about a directory it has no reason to create.
	if (resuming > 0) {
		const sessionsDir = env.PI_SESSIONS_DIR;
		if (!sessionsDir) {
			checks.push({
				ok: false,
				label: `${resuming} trigger(s) set run.resume but PI_SESSIONS_DIR is unset`,
				fix: "set PI_SESSIONS_DIR to a private directory (mode 0700, OUTSIDE any git repo) -- these jobs refuse pre-spend until you do, deliberately, rather than running unpersisted and looking like they worked",
			});
		} else {
			const exists = fileExists(sessionsDir);
			checks.push({
				ok: exists,
				label: `Session store ${exists ? "exists" : "does not exist"} (${sessionsDir})`,
				fix: `create it: mkdir -p ${sessionsDir} && chmod 700 ${sessionsDir}`,
				// Silent tier: setting PI_SESSIONS_DIR WAS the decision, and it has already been made -- the
				// mkdir is the mechanical remainder, creates only the path the env var names, and 0700 is
				// the mode the fix line already prescribes (transcripts are PII-bearing, host-only).
				fixAction: {
					tier: "silent",
					describe: `mkdir -p ${sessionsDir} && chmod 700 ${sessionsDir}`,
					run: async ({ mkdir, chmod }) => {
						mkdir(sessionsDir, { recursive: true });
						chmod(sessionsDir, 0o700);
						return { ok: true, note: "mode 0700" };
					},
				},
			});
			// Not a failure -- a warning, because it is a disclosure the operator may have accepted
			// knowingly. A transcript holds tool output, file contents and the agent's own reasoning, which
			// is strictly more than logs/<jobId>.log holds, and that one is opt-in for this reason.
			checks.push({
				ok: true,
				warn: true,
				label: `${resuming} trigger(s) persist agent transcripts to ${sessionsDir} -- PII-bearing, host-only, never committed`,
				fix: "confirm it is outside every git repo and on a disk you would put issue text on; PI_SESSIONS_TTL_DAYS bounds how long a transcript stays resumable",
			});
		}
	}

	// REQ-PER-TRIGGER-INSTRUCTION. A plain fact line, not a warning: standing text is an ordinary operator
	// choice. It is reported at all because it changes what EVERY job of that trigger is told, and unlike a
	// flow (which lives in the repo, reviewed by a merge) it lives only in triggers.json, so nothing else
	// would put it in front of the operator. The COUNT only -- the text itself is theirs and may be long.
	if (instructing > 0) {
		checks.push({
			ok: true,
			label: `${instructing} trigger(s) attach a standing instruction to every job's prompt`,
		});
	}

	// REQ-REPLICA-RUNS. A warning, never a failure -- replicas are an opt-in an operator chose in a reviewed
	// file, and the harness is doing exactly what was asked. What is worth saying is the arithmetic: each
	// replica reserves its OWN budget slot before its own tokens (CONST-BUDGET-BEFORE-TOKENS), so a delivery
	// on a `replicas: 2` trigger consumes two, and the daily cap divides accordingly. Only reported when a
	// trigger actually asked for it.
	if (replicating > 0) {
		checks.push({
			ok: true,
			warn: true,
			// Both facts live in the LABEL rather than the fix, because an `ok: true` check never prints its
			// fix line (the loop below) -- and the concurrency half is the one an operator most often has
			// wrong: replicas above PI_CONCURRENCY queue instead of racing, which looks like the feature
			// silently not working.
			label: `${replicating} trigger(s) set run.replicas -- one delivery reserves one budget slot PER replica; PI_CONCURRENCY bounds how many actually race`,
			fix: "confirm the daily/weekly/monthly caps account for the multiplier, and that PI_CONCURRENCY is at least the largest run.replicas",
		});
	}

	// REQ-SCOPED-PAUSE-WINDOWS, the panel-writes-what-the-worker-ignores trap (issue #99). Three defaults
	// that are individually defensible and together silent:
	//
	//   - `pi-dispatch init` SCAFFOLDS ./pause-windows.json and leaves PI_PAUSE_WINDOWS_FILE commented out;
	//   - the admin panel defaults to ./pause-windows.json in its OWN cwd, so `w` reads and WRITES that file
	//     and reports every window it adds as applied live;
	//   - the worker has NO cwd default (config.mjs: `?? null`, and null means the feature is off).
	//
	// So an operator adds quiet hours in the panel, is told it is live, and nothing ever pauses -- the one
	// failure mode where the UI actively asserts the opposite of the truth. The worker's fail-closed default
	// is deliberate and is NOT changed here: a worker must not start honouring a file nobody pointed it at,
	// least of all one that stops paid work. The mismatch is a deployment fact, so doctor is where it
	// belongs. Warn, never fail, like every other setup-shaped check: a deployment can legitimately be
	// mid-setup, and a scaffolded file the operator never intended to use is not a fault.
	//
	// Empty counts as unset, mirroring `if (config.pauseWindowsFile)` at the worker's own load site.
	//
	// NEVER TIER, deliberately no fixAction: doctor cannot know which path the operator meant. This cwd is
	// doctor's, not necessarily the worker's (a service manager sets its own), and writing an env line into
	// .env would be doctor guessing a semantic value -- the same refusal PI_GLOBAL_ALLOW_EXTENSIONS gets.
	// The fix line names the variable and the absolute path, and the operator decides.
	//
	// SUBSCRIPTIONS GET NO SUCH CHECK, checked rather than assumed: ./subscriptions.json is scaffolded by the
	// same init and PI_SUBSCRIPTIONS_FILE is commented out the same way, but the admin extension is its ONLY
	// reader and writer (nothing reads it at job time), and the admin's own default IS ./subscriptions.json
	// (admin/src/read-model.mjs) -- so with the variable unset the one component that cares already finds the
	// scaffolded file. There is no second reader to disagree with, hence no trap, hence no warn: a line that
	// fires where nothing is broken teaches operators to skim past the ones that matter.
	{
		const pauseWindowsFile = env.PI_PAUSE_WINDOWS_FILE;
		const scaffolded = join(cwd, "pause-windows.json");
		if ((typeof pauseWindowsFile !== "string" || pauseWindowsFile.trim() === "") && fileExists(scaffolded)) {
			checks.push({
				ok: false,
				warn: true,
				label: `${scaffolded} exists but PI_PAUSE_WINDOWS_FILE is unset -- the worker ignores it, so scoped pauses are OFF`,
				fix: `set PI_PAUSE_WINDOWS_FILE=${scaffolded} in .env and restart the worker -- unset means the worker loads no windows at all, while the admin panel defaults to this same file and reports each window it writes as applied live; delete the file if this deployment has no quiet hours`,
			});
		}
	}

	// REQ-RESURRECTABLE-SANDBOX. A warning, never a failure: retention is a convenience, and the only thing
	// worth surfacing is that finished runs' directories -- a repository clone plus the run's prompt.md and
	// event.json, so issue text -- are sitting on disk, and how many. An operator who never opens a sandbox
	// should still know they are being kept.
	{
		const retentionHours = nonNegativeEnvInt(env.PI_SANDBOX_RETENTION_HOURS, 24);
		const sandboxDir = env.PI_SANDBOX_DIR || defaultSandboxDir(env);
		if (retentionHours === 0) {
			checks.push({ ok: true, label: "Workspace retention off (PI_SANDBOX_RETENTION_HOURS=0) — finished runs are deleted, none are re-openable" });
		} else {
			const kept = countRetained(sandboxDir, fileExists);
			checks.push({
				ok: true,
				warn: kept.count > 0,
				label: `${kept.count} retained workspace(s) in ${sandboxDir}, swept after ${retentionHours}h — re-open one with \`pi-dispatch sandbox <jobId>\``,
				fix: "each holds the run's clone plus its prompt.md/event.json (issue text); PI_SANDBOX_RETENTION_HOURS=0 turns retention off entirely",
			});
		}
	}

	return checks;
}

/**
 * How many retained workspaces are sitting in the retention root.
 *
 * Reads its OWN env rather than loadConfig, like every other doctor check (`doctor.mjs` header): a broken
 * GitHub auth must not stop the operator finding out how much disk this is using. Never throws -- an
 * unreadable or absent root reports zero, which is the honest answer to "how many can I open".
 */
function countRetained(sandboxDir, fileExists) {
	if (!fileExists(sandboxDir)) return { count: 0 };
	try {
		return { count: readdirSync(sandboxDir).length };
	} catch {
		return { count: 0 };
	}
}

/** PI_SANDBOX_RETENTION_HOURS, parsed the same permissive way the admin's own env reads are. */
function nonNegativeEnvInt(raw, fallback) {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isInteger(n) && n >= 0 && String(n) === String(raw).trim() ? n : fallback;
}

function nodeCheck(version) {
	const [maj, min] = version.split(".").map((n) => Number.parseInt(n, 10));
	const ok = maj > NODE_FLOOR[0] || (maj === NODE_FLOOR[0] && min >= NODE_FLOOR[1]);
	return {
		ok,
		label: `Node ≥ ${NODE_FLOOR[0]}.${NODE_FLOOR[1]} (have ${version})`,
		fix: `upgrade Node to ${NODE_FLOOR[0]}.${NODE_FLOOR[1]} or newer`,
	};
}

/**
 * What does the trigger file say about the staged packages (INT-TRIGGERS-FILE-CONTRACT)?
 *
 * `images` is the sorted set of distinct `run.image` values across the file (issue #41), so doctor can check
 * that every image a trigger names is actually on this host -- with `--pull=never` nothing will fetch one at
 * job time, so this is the only warning that arrives BEFORE the trigger fires at 03:00.
 *
 * `optingOut` counts `run.packages: false` -- the only thing that now withholds the staged set from a job.
 * `requiring` counts explicit `run.packages: true`, which arms nothing any more but is still an operator
 * asserting "this flow needs those packages"; that assertion is what makes an empty stage a hard failure.
 *
 * `repositories` is the sorted set of distinct `run.repository` values on github-kind triggers, feeding the
 * branch-protection preflight (issue #80). Note the shared schema currently ADMITS `run.repository` only on
 * azure label/comment triggers (triggers.mjs, validateRepository), so this set is empty today for every
 * valid file -- collected here anyway, rather than hard-coded empty, so the preflight lights up the day the
 * schema grows the field for github instead of silently never running.
 *
 * Parsed with the SHARED `parseTriggers`, so doctor counts exactly the entries the worker and receiver will
 * act on -- a truthy `"true"` string is rejected there and therefore never counted here.
 *
 * Swallows ANY error to zeroes -- a missing, unreadable, or malformed triggers file already fails LOUD at
 * worker boot (config.mjs, schedules.mjs), so re-reporting the parse failure here would only bury doctor's
 * own findings under a second copy of a diagnosis the operator already gets.
 */
/** lstat, so a symlinked skillsDir is judged on its own inode -- copy-tree.mjs's rule, restated. */
function dirExists(dir) {
	try {
		return lstatSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Dry-run the REAL copier against a skills dir, into a throwaway destination that is removed again.
 *
 * Deliberately the same function the job path calls rather than a reimplementation of its rules: a
 * second, agreeing-by-hand checker is how doctor comes to report green on a directory the worker then
 * refuses. The cost is one copy of a bounded tree, on a command an operator runs by hand.
 */
function probeSkillsDir(dir) {
	const scratch = mkdtempSync(join(tmpdir(), "pi-doctor-skills-"));
	try {
		return copySkillTree(dir, scratch);
	} catch {
		return { refused: "skills-dir-unreadable" };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The operator-facing fix line for each refusal the copier can return. */
function probeFix(reason, dir) {
	if (reason === "skills-dir-empty") {
		return `${dir} holds no usable <name>/SKILL.md, so every job of that trigger refuses as skills-dir-empty -- point run.skillsDir at the directory whose CHILDREN are skill dirs (the ~/.pi/agent/skills layout)`;
	}
	if (reason === "skills-dir-too-deep") return `${dir} nests deeper than the copier walks -- flatten it`;
	if (reason === "skills-dir-too-many-files") return `${dir} holds more files than one job may carry -- split the set across triggers`;
	if (reason === "skills-dir-unreadable") return `${dir} could not be read -- check its permissions on the worker host`;
	return `${dir} is over the injection size caps -- trim it, or split the set across triggers`;
}

/**
 * The injected skills that carry `ai-trigger: allow`, which is the opt-in that will never be honoured.
 *
 * Reads only `<dir>/<name>/SKILL.md`, and never throws: this is a warning, and a doctor line must not be
 * the thing that fails a doctor run. The frontmatter test mirrors flow-gate.mjs's -- deliberately a
 * loose one here, because over-reporting a skill that would not have opened the gate anyway is harmless
 * while missing one leaves the operator's opt-in silently dead.
 */
function aiTriggerNames(dir) {
	const names = [];
	try {
		for (const name of readdirSync(dir)) {
			try {
				const text = readFileSync(join(dir, name, "SKILL.md"), "utf8");
				if (/^ai-trigger:\s*("?)allow\1\s*$/m.test(text)) names.push(name);
			} catch {
				// no SKILL.md, or unreadable: not a skill that could have opted in.
			}
		}
	} catch {
		// unreadable dir: the presence check above already reported it.
	}
	return names;
}

/**
 * Does `.pi/skills/<flow>/SKILL.md` exist at HEAD of a local folder? "present" | "absent" | "unknown".
 *
 * Deliberately NOT readFlowGate: that module answers WHO may fire a flow (the ai-trigger frontmatter,
 * at a caller-pinned sha) and its catch collapses ANY git failure into deny -- fail-closed is right
 * for a gate and exactly wrong here, where deny-because-git-broke would print a confident wrong
 * answer on an advisory line. Doctor resolving HEAD itself is also fine: the gate's no-ref rule
 * defends against an agent self-authorizing mid-run, and a host-side preflight has no agent. What IS
 * the gate's, verbatim, is the ls-tree read, the 100644-blob requirement and the hardening flags --
 * copied so the two readers cannot disagree about what "a committed skill file" means, and so a
 * hostile repo config cannot run code during the read (flow-gate.mjs's defaultGit, restated).
 */
const GIT_READ_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-pager"];
async function repoFlowAtHead(spawn, folder, flow) {
	if (!SKILL_NAME_RE.test(flow)) return "unknown"; // the caller pre-checks; belt against interpolation
	const head = await runCmdCapture(spawn, "git", [...GIT_READ_FLAGS, "-C", folder, "rev-parse", "HEAD"]);
	const sha = head.code === 0 ? head.output.trim() : null;
	if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return "unknown";
	const tree = await runCmdCapture(spawn, "git", [...GIT_READ_FLAGS, "-C", folder, "ls-tree", "-z", sha, `.pi/skills/${flow}/SKILL.md`]);
	if (tree.code !== 0) return "unknown";
	const record = tree.output.split("\0").find((r) => r);
	if (!record) return "absent"; // valid sha, path absent at that commit
	const tab = record.indexOf("\t");
	const [mode, type] = tab === -1 ? [] : record.slice(0, tab).split(/\s+/);
	// A symlink/gitlink entry is "absent" for this question too: the gate would refuse it, and the
	// materialiser never copies it, so nothing downstream treats it as a skill file.
	return mode === "100644" && type === "blob" ? "present" : "absent";
}

function readTriggerFacts(env, fileExists, cwd) {
	const none = { requiring: 0, optingOut: 0, resuming: 0, replicating: 0, instructing: 0, commands: 0, images: [], skillsDirs: [], forges: [], repositories: [], flows: [] };
	try {
		// Unset falls back to ./triggers.json in cwd, MIRRORING the receiver's own default
		// (receiver/src/config.mjs) -- the two must read the same file, or doctor preflights a deployment
		// the receiver will not boot. An absent file still means "no triggers at all", exactly as before.
		const path = env.PI_TRIGGERS_FILE ?? join(cwd, "triggers.json");
		if (!fileExists(path)) return none;
		const triggers = parseTriggers(readFileSync(path, "utf8"), path);
		return {
			requiring: triggers.filter((t) => t.run.packages === true).length,
			resuming: triggers.filter((t) => t.run.resume === true).length,
			// REQ-PER-TRIGGER-INSTRUCTION. Counted beside `resuming` for the same reason: it is a per-trigger
			// choice that changes what every job of it is told, and an operator should see it before it fires.
			instructing: triggers.filter((t) => typeof t.run.instructions === "string").length,
			// REQ-REPLICA-RUNS. `> 1` rather than `!== undefined` because the loader already refuses anything
			// else -- this counts triggers that will actually multiply spend, which is the only reason to say so.
			replicating: triggers.filter((t) => t.run.replicas > 1).length,
			// run.command triggers (issue #189), counted for the one advisory line below. The `flows`
			// tuple list already filters to `typeof f.flow === "string"`, so a command trigger drops out
			// of the flow-tier probes naturally -- no exclusion needed there.
			commands: triggers.filter((t) => typeof t.run.command === "string").length,
			optingOut: triggers.filter((t) => t.run.packages === false).length,
			images: [...new Set(triggers.map((t) => t.run.image).filter((i) => typeof i === "string"))].sort(),
			// REQ-PER-TRIGGER-SKILLS. The distinct host directories the file names, deduped like `images`,
			// because the checks below cost a filesystem walk each and two triggers sharing a directory are one
			// question.
			skillsDirs: [...new Set(triggers.map((t) => t.run.skillsDir).filter((d) => typeof d === "string"))].sort(),
			// The forges this file actually needs credentials for. Read from the triggers rather than from
			// the env, so the check answers "is what you configured enough for what you wrote" instead of
			// "did you set some variables".
			//
			// `isForgeKind` rather than a written-out pair: this whole function is wrapped in `catch { return
			// none }`, so a forge missing from a hand-written filter would not merely be unchecked -- doctor
			// would report all-green and never mention that the credential it needs was never looked for.
			forges: [...new Set(triggers.map((t) => t.run.kind).filter(isForgeKind))].sort(),
			repositories: [...new Set(triggers.filter((t) => t.run.kind === "github" && typeof t.run.repository === "string").map((t) => t.run.repository))].sort(),
			// REQ-PER-TRIGGER-SKILLS (issue #189). Per-trigger TUPLES, unlike every deduped set above,
			// because a flow-resolution answer depends on the trigger's own folder/skillsDir/packages --
			// two triggers naming the same flow with different skillsDirs are two different questions.
			// The label is how a line names its trigger: cron entries by their id, id-less webhook
			// entries by raw file position (the admin's trigger:<index> identity).
			flows: triggers
				.map((t, index) => ({
					label: t.on.type === "cron" ? `cron "${t.on.id}"` : `${t.on.type} trigger #${index}`,
					flow: t.run.flow,
					kind: t.run.kind,
					folder: typeof t.run.folder === "string" ? t.run.folder : null,
					skillsDir: typeof t.run.skillsDir === "string" ? t.run.skillsDir : null,
					packages: t.run.packages !== false,
				}))
				.filter((f) => typeof f.flow === "string"),
		};
	} catch {
		return none;
	}
}

/**
 * READ-ONLY branch-protection preflight for the github repos the triggers file names (issue #80,
 * REQ-BRANCH-PROTECTION-PRECONDITION). Two `gh api` GETs per repo -- resolve the default branch, then ask
 * the protection endpoint -- and never anything else: doctor reports repo settings, it does not change
 * them, so the fix line SHOWS the settings page rather than running a PUT.
 *
 * A non-zero exit on the protection endpoint deliberately conflates GitHub's determinate 404 ("no
 * protection") with transient errors. The worker's own gate does the 404-vs-retryable split, because there
 * a false "unprotected" would disarm the never-merge backstop (github-host.mjs, issue #61) -- here every
 * answer is an advisory warn, and a warn that occasionally fires on a flaky API is acceptable where a
 * false ✓ would not be.
 *
 * Exported rather than folded into runDoctor: the shared schema admits `run.repository` only on azure
 * triggers today (see readTriggerFacts), so no valid triggers file can reach this loop through runDoctor
 * yet -- tests exercise it directly, and the runDoctor wiring is already live for the day the schema
 * grows the field for github. Returns check objects in runDoctor's `{ok, warn, label, fix}` shape.
 */
export async function githubProtectionPreflight(spawn, repositories) {
	const checks = [];
	// gh availability first, mirroring the GITHUB_AUTH_SOURCE=gh handling in runDoctor: one warn covers
	// every repo, and the loop is skipped rather than producing one confusing failure line per repo.
	const status = await runCmdCapture(spawn, "gh", ["auth", "status"]);
	if (status.code !== 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `branch-protection preflight skipped: gh is unavailable or not logged in (${repositories.length} github repo(s) named in triggers.json)`,
			fix: "install gh and run `gh auth login` -- the preflight is a read-only `gh api` per repo; the worker still enforces REQ-BRANCH-PROTECTION-PRECONDITION at job time either way",
		});
		return checks;
	}
	// Bounded so a large trigger file cannot turn doctor into a network crawl: two API round-trips per
	// repo, five repos. The rest are not silently dropped -- the cap line says so, and job time enforces.
	const capped = repositories.slice(0, 5);
	if (repositories.length > capped.length) {
		checks.push({
			ok: true,
			label: `branch-protection preflight capped at ${capped.length} of ${repositories.length} repos -- the rest are still enforced per job before any spend`,
		});
	}
	for (const repo of capped) {
		const branch = await runCmdCapture(spawn, "gh", ["api", `repos/${repo}`, "--jq", ".default_branch"]);
		const name = branch.code === 0 ? branch.output.trim() : "";
		if (!name) {
			checks.push({
				ok: false,
				warn: true,
				label: `could not resolve the default branch of ${repo} -- branch protection not preflighted`,
				fix: "check the run.repository value and this gh login's access to it; the worker still refuses an unprotected repo at job time",
			});
			continue;
		}
		const code = await runCmd(spawn, "gh", ["api", `repos/${repo}/branches/${name}/protection`]);
		checks.push(
			code === 0
				? { ok: true, label: `default branch of ${repo} is protected (${name})` }
				: {
						ok: false,
						warn: true,
						label: `default branch of ${repo} is not protected -- the worker refuses forge jobs on unprotected repos before any spend (REQ-BRANCH-PROTECTION-PRECONDITION)`,
						fix: `protect ${name} at https://github.com/${repo}/settings/branches (see SECURITY.md) -- a read-only preflight, doctor never changes repo settings`,
					},
		);
	}
	return checks;
}

/** Resolve a spawned command's exit code; null means it could not be launched (e.g. not on PATH). */
function runCmd(spawn, cmd, args) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: "ignore" });
		} catch {
			resolve(null);
			return;
		}
		child.on("error", () => resolve(null)); // ENOENT etc. — the binary is not available
		child.on("close", (code) => resolve(code));
	});
}

/**
 * Like runCmd but collects stdout+stderr into one combined string — gh moves its human output between
 * the two across versions, so callers get both. Resolves `{code, output}`; `code: null` when the command
 * could not be launched or overran the timeout (default 30s, so a hung docker daemon cannot stall doctor).
 * `opts.env` is passed through to the spawn so secrets can travel via env instead of argv; `opts.cwd`
 * likewise, for the child-process fixActions that must run where doctor's own cwd seam points.
 */
/**
 * The build-ish scripts a staged package declares, which `--ignore-scripts` means did NOT run (issue #102).
 * `prepare` and `build` join the stager's own trio because a package can declare either and still ship
 * unbuilt sources. Returns [] for anything unreadable: a package we cannot parse is not a finding.
 */
function buildScriptsOf(packageDir, fileExists) {
	const path = join(packageDir, "package.json");
	if (!fileExists(path)) return [];
	try {
		const scripts = JSON.parse(readFileSync(path, "utf8"))?.scripts ?? {};
		return ["prepare", "postinstall", "install", "build"].filter((key) => typeof scripts[key] === "string");
	} catch {
		return [];
	}
}

function runCmdCapture(spawn, cmd, args, opts = {}) {
	const { timeoutMs = 30000 } = opts;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
		} catch {
			resolve({ code: null, output: "" });
			return;
		}
		let output = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, output });
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			finish(null);
		}, timeoutMs);
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => (output += d));
		child.on("error", () => finish(null)); // ENOENT etc. — the binary is not available
		child.on("close", (code) => finish(code));
	});
}

/**
 * Pull the scope list out of `gh auth status` output. The line reads like
 * `  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'` (older gh omits the quotes). Returns null
 * when the line is absent — fine-grained tokens report no classic scopes at all.
 */
function parseGhTokenScopes(output) {
	const m = output.match(/Token scopes:\s*(.+)/);
	if (!m) return null;
	return m[1]
		.split(",")
		.map((s) => s.trim().replace(/^'(.*)'$/, "$1"))
		.filter((s) => s.length > 0);
}

/**
 * Reachability probe with a raw, fail-fast ioredis client. `lazyConnect` holds the connect until the
 * error handler is attached, so a down Valkey is reported as one ✗ line — not the ioredis stack traces
 * a BullMQ Queue's internal client would dump. Reuses `parseConnection`'s fail-fast options (cli.mjs:88).
 */
async function defaultProbeValkey(url) {
	const { Redis } = await import("ioredis");
	const { parseConnection } = await import("./connection.mjs");
	const client = new Redis({ ...parseConnection(url, { failFast: true }), lazyConnect: true });
	client.on("error", () => {}); // swallow connect errors + retries; reachability is the ✓/✗, not a trace
	try {
		await client.connect();
		await client.ping();
		return true;
	} catch {
		return false;
	} finally {
		client.disconnect();
	}
}
