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
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { defaultSandboxDir, globalExtensionsEnabled } from "./config.mjs";
import { isForgeKind } from "./forges.mjs";
import { findLiteralSecret, ADMIN_RE } from "./import-pi.mjs";
import { PACKAGES_SUBDIR, readStageManifest } from "./packages.mjs";
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

export async function runDoctor(env = process.env, deps = {}) {
	const {
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		spawn = nodeSpawn,
		probeValkey = defaultProbeValkey,
		fileExists = existsSync,
		nodeVersion = process.versions.node,
	} = deps;

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
	const { requiring, optingOut, resuming, replicating, images, forges } = readTriggerFacts(env, fileExists);

	// Only meaningful if docker itself responds; otherwise the image check is noise on top of a down daemon.
	const imageCode = dockerCode === 0 ? await runCmd(spawn, "docker", ["image", "inspect", jobImage]) : null;
	checks.push({
		ok: imageCode === 0,
		label: `Job image present (${jobImage})`,
		fix: "docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest  (or build image/Dockerfile)",
	});

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
			checks.push({
				ok: !fileExists(join(overlay, "auth.json")),
				label: "Overlay is credential-free (no auth.json)",
				fix: "delete auth.json from the overlay — the provider key belongs in env, never a mounted file",
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
				const manifest = readStageManifest({ globalPiDir: overlay, readFile: (p) => readFileSync(p, "utf8"), fileExists });
				if (!manifest) {
					checks.push({
						ok: false,
						label: `Staged packages manifest readable (${PACKAGES_SUBDIR}/packages.json)`,
						fix: "re-run `pi-dispatch import-pi --with-packages` -- without the manifest nothing knows what is staged, so no package is ever loaded",
					});
				} else {
					// A manifest entry whose dir is gone loads nothing, and pi reports no error for a package
					// it was never told about -- the stage is only as real as the dirs behind the names.
					const missing = manifest.packages.filter((p) => !fileExists(join(packagesDir, p.dir))).map((p) => p.name);
					checks.push({
						ok: missing.length === 0,
						label: `Staged packages present (${manifest.packages.map((p) => `${p.name}@${p.version}`).join(", ")})`,
						fix: `staged dir missing for ${missing.join(", ")} -- re-run \`pi-dispatch import-pi --with-packages\` to restage`,
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

	let failed = false;
	for (const c of checks) {
		out(`${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.label}\n`);
		if (!c.ok) {
			out(`    → ${c.fix}\n`);
			if (!c.warn) failed = true;
		}
	}
	out(failed ? "\ndoctor: some checks failed — fix the above, then re-run.\n" : "\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n");
	return failed ? 1 : 0;
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
 * Parsed with the SHARED `parseTriggers`, so doctor counts exactly the entries the worker and receiver will
 * act on -- a truthy `"true"` string is rejected there and therefore never counted here.
 *
 * Swallows ANY error to zeroes -- a missing, unreadable, or malformed triggers file already fails LOUD at
 * worker boot (config.mjs, schedules.mjs), so re-reporting the parse failure here would only bury doctor's
 * own findings under a second copy of a diagnosis the operator already gets.
 */
function readTriggerFacts(env, fileExists) {
	const none = { requiring: 0, optingOut: 0, resuming: 0, replicating: 0, images: [], forges: [] };
	try {
		const path = env.PI_TRIGGERS_FILE; // config.mjs's own default is null -- unset means no triggers at all
		if (!path || !fileExists(path)) return none;
		const triggers = parseTriggers(readFileSync(path, "utf8"), path);
		return {
			requiring: triggers.filter((t) => t.run.packages === true).length,
			resuming: triggers.filter((t) => t.run.resume === true).length,
			// REQ-REPLICA-RUNS. `> 1` rather than `!== undefined` because the loader already refuses anything
			// else -- this counts triggers that will actually multiply spend, which is the only reason to say so.
			replicating: triggers.filter((t) => t.run.replicas > 1).length,
			optingOut: triggers.filter((t) => t.run.packages === false).length,
			images: [...new Set(triggers.map((t) => t.run.image).filter((i) => typeof i === "string"))].sort(),
			// The forges this file actually needs credentials for. Read from the triggers rather than from
			// the env, so the check answers "is what you configured enough for what you wrote" instead of
			// "did you set some variables".
			//
			// `isForgeKind` rather than a written-out pair: this whole function is wrapped in `catch { return
			// none }`, so a forge missing from a hand-written filter would not merely be unchecked -- doctor
			// would report all-green and never mention that the credential it needs was never looked for.
			forges: [...new Set(triggers.map((t) => t.run.kind).filter(isForgeKind))].sort(),
		};
	} catch {
		return none;
	}
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
 * `opts.env` is passed through to the spawn so secrets can travel via env instead of argv.
 */
function runCmdCapture(spawn, cmd, args, opts = {}) {
	const { timeoutMs = 30000 } = opts;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}) });
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
