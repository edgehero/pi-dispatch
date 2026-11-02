/**
 * `pi-dispatch import-pi` — stage a CREDENTIAL-FREE copy of the host's `pi` setup into a global overlay
 * dir, so every job can reuse it (REQ-GLOBAL-PI-OVERLAY). Point `PI_GLOBAL_PI_DIR` at the result and the
 * worker mounts it `:ro` into each container, layered UNDER each repo's own `.pi/`.
 *
 * The overlay must never carry a secret (CONST-TOKEN-SCOPED-PER-JOB): the provider key stays in the host's
 * `auth.json` / env and reaches the container through the env allowlist, never a mounted file. So this
 * command copies only the safe subset and REFUSES a `models.json` that embeds a literal key.
 *
 * Copied:   models.json (definitions only, sanitized), skills/, APPEND_SYSTEM.md, mcp.json (rewritten to the
 *           servers a job may connect, references only; `--no-mcp` leaves it out), and extensions/ (verbatim;
 *           the admin extension is hard-blocked, and one the operator disabled in `pi config` is left behind).
 *           Extensions come along BY DEFAULT -- staging is the vetting step, and an overlay missing the
 *           operator's own extensions is not the setup they asked for -- with `--no-extensions` as the escape
 *           hatch. Every extension staged is PRINTED by name, because this is the moment the operator can
 *           still see what is about to run inside every job container.
 * Staged:   packages/ — only under --with-packages — pinned third-party pi packages, installed here on the
 *           host so a job container can load them from the overlay with NO network access (issue #58). Under
 *           that flag the packages the operator installed with `pi install` are DISCOVERED from their own pi
 *           setup and staged at the exact version their host runs (issue #102); `pi-packages.json` becomes
 *           the override-and-addition layer rather than the only road in, and `--no-host-packages` restores
 *           the declared-only behaviour exactly.
 * Never:    auth.json, settings.json, sessions/, themes/, prompts/, tools/, mcp-auth.json (pi's MCP sign-ins).
 *           Discovery READS settings.json to learn what pi has installed and what the operator turned off;
 *           reading is not copying, and no part of that file reaches the overlay.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, statSync, copyFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { FROM_HOST, PACKAGES_SUBDIR, mergeHostPackages, parsePackagesFile } from "./packages.mjs";
import { newStagingDir, preparePackage, pruneStagedTrees, stagedTreeName, withStageLock, writeStageManifest } from "./package-stage.mjs";
import { agentDirFrom, readHostPi } from "./host-pi.mjs";
import { ENTRY_NAME_RE, copyDirContents, copySkillTree } from "./copy-tree.mjs";
import { MCP_CONFIG_FILE_NAME, MCP_CONFIG_MAX_BYTES, mcpServerWhere, overlayMcpText, parseOverlayMcp } from "./mcp-config.mjs";

/**
 * A valid skill/extension entry name. Defined in copy-tree.mjs, which is the module that enforces it,
 * and re-exported from here because this is the address its readers already use (the materialiser's
 * drift test, this module's own tests). Renaming an import path that has readers is not a tidy-up.
 */
export { ENTRY_NAME_RE };
/** The admin extension — never duplicated into a job overlay (it can enqueue paid jobs: a recursion vector). */
export const ADMIN_RE = /pi-dispatch|dispatch-admin/i;

/**
 * Every flag this command accepts. Unknown ones are REFUSED (issue #102) rather than ignored: argv here is
 * parsed by a bare indexOf, so before discovery a typo was harmless, but `--no-host-package` (singular) now
 * silently means "third-party code you did not expect runs in every job container". A typo must not be able
 * to widen what loads.
 */
const BOOL_FLAGS = new Set(["--no-extensions", "--with-extensions", "--with-packages", "--host-packages", "--no-host-packages", "--no-mcp"]);
const VALUE_FLAGS = new Set(["--from", "--to", "--packages-file"]);

const execFileAsync = promisify(execFile);

/**
 * The default package-stager runner. ARRAY argv, never a shell string -- a package name from a config file
 * must never be able to become shell syntax on the operator's host. See `npmExecOptions` for the one
 * platform on which `shell: true` is nonetheless unavoidable, and why it is safe there.
 */
function defaultExec(file, args, options) {
	return execFileAsync(file, args, options);
}

// The host's pi agent dir (env override, else ~/.pi/agent). The resolution moved to host-pi.mjs, which now
// needs the same answer for discovery and hands it to doctor as well; this alias keeps the call site here
// reading the way it always did.
const defaultFrom = agentDirFrom;

/** A config value that defers to the environment/a command rather than embedding a literal secret. */
function isIndirection(v) {
	return typeof v === "string" && (v.startsWith("$") || v.startsWith("!"));
}

/**
 * Find a literal secret in a parsed models.json. Returns a human-readable location, or null if clean.
 * A provider `apiKey`, or an auth-ish header, that is a plain string (not `$ENV` / `!cmd`) is a literal.
 */
export function findLiteralSecret(models) {
	const providers = models?.providers;
	if (!providers || typeof providers !== "object") return null;
	for (const [name, cfg] of Object.entries(providers)) {
		if (typeof cfg?.apiKey === "string" && !isIndirection(cfg.apiKey)) return `providers.${name}.apiKey`;
		const headers = cfg?.headers;
		if (headers && typeof headers === "object") {
			for (const [h, val] of Object.entries(headers)) {
				if (/auth|api[-_]?key|token|secret|bearer/i.test(h) && typeof val === "string" && !isIndirection(val)) {
					return `providers.${name}.headers.${h}`;
				}
			}
		}
	}
	return null;
}

export async function runImportPi(argv = [], deps = {}) {
	const {
		env = process.env,
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		// lstatSync rides along for the shared copier, whose symlink guard is the whole point of it: the
		// walker this dir's copies used to go through guarded with statSync, which FOLLOWS links.
		fs = { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, statSync, copyFileSync, renameSync, rmSync, unlinkSync },
		exec = defaultExec,
		// Injected like `fs`/`exec`/`out` so the win32 npm branch below is reachable from a test on any host;
		// it is the branch that was dead on arrival precisely because nothing could exercise it here.
		platform = process.platform,
	} = deps;

	const unknown = unknownFlag(argv);
	if (unknown) {
		out(`error: unknown flag ${JSON.stringify(unknown)}\n  Accepted: ${[...VALUE_FLAGS].map((f) => `${f} <value>`).join(", ")}, ${[...BOOL_FLAGS].join(", ")}.\n`);
		return 1;
	}

	// Extensions are copied unless the operator says otherwise. `--with-extensions` is still accepted and is
	// now a no-op, so an existing setup script keeps working and keeps meaning what it always meant.
	const withExtensions = !argv.includes("--no-extensions");
	const withPackages = argv.includes("--with-packages");
	// Discovery rides inside --with-packages rather than arriving as a third gate. A flagless import still
	// stages nothing, exactly as before; the only run whose behaviour moved is one that already asked for
	// "the packages" and until now silently got a subset that excluded whatever `pi install` had put there.
	// `--host-packages` is accepted as a no-op for symmetry with `--with-extensions`.
	const withHostPackages = withPackages && !argv.includes("--no-host-packages");
	const from = flagValue(argv, "--from") ?? defaultFrom(env);
	// Absolute, always (PR #553's review): the next steps print it as the PI_GLOBAL_PI_DIR to set, and the worker
	// refuses a relative one, since the worker and the container runtime resolve it differently.
	const to = resolve(cwd, flagValue(argv, "--to") ?? "pi-global");
	const packagesFile = flagValue(argv, "--packages-file") ?? env.PI_PACKAGES_FILE ?? join(cwd, "pi-packages.json");

	if (!fs.existsSync(from)) {
		out(`error: no pi setup found at ${from}\n  Is pi installed and configured? Set PI_CODING_AGENT_DIR or pass --from <dir>.\n`);
		return 1;
	}

	// Pre-flight the one hard security gate BEFORE writing anything: a literal key in models.json aborts the
	// whole import so no half-overlay is produced and no secret is ever written to the overlay.
	const modelsSrc = join(from, "models.json");
	let modelsText;
	if (fs.existsSync(modelsSrc)) {
		modelsText = fs.readFileSync(modelsSrc, "utf8");
		let parsed;
		try {
			parsed = JSON.parse(modelsText);
		} catch {
			modelsText = null; // malformed: skip it with a warning rather than abort the whole import
		}
		if (parsed) {
			const leak = findLiteralSecret(parsed);
			if (leak) {
				out(
					`error: ${modelsSrc} embeds a literal secret at ${leak}.\n` +
						`  The overlay is mounted into an adversarial-input container, so it must be credential-free.\n` +
						`  Move the key to auth.json (\`pi\` login) or reference the environment (e.g. "$MY_KEY"), then re-run.\n`,
				);
				return 1;
			}
		}
	}

	// Read the operator's own pi setup ONCE, after the secret gate so a refused import never spawned a
	// package manager, and before the extensions copy because that copy now depends on it (issue #102).
	const hostPi = await readHostPi({ agentDir: from, fs, exec, platform, withPackages: withHostPackages });

	const results = [];
	fs.mkdirSync(to, { recursive: true });

	// models.json — definitions only, already proven literal-secret-free above.
	if (modelsText) {
		fs.writeFileSync(join(to, "models.json"), modelsText);
		results.push(["models.json", "custom model/provider definitions (credential-free)"]);
	} else if (fs.existsSync(modelsSrc)) {
		results.push(["models.json", "SKIPPED — not valid JSON"]);
	}

	// skills/ — copy each named skill dir (SKILL.md + its files), skipping symlinks and odd names.
	const skillsCount = copyNamedDirs(fs, join(from, "skills"), join(to, "skills"), out);
	if (skillsCount > 0) results.push(["skills/", `${skillsCount} skill${skillsCount === 1 ? "" : "s"}`]);

	// APPEND_SYSTEM.md — the operator's global persona.
	if (fs.existsSync(join(from, "APPEND_SYSTEM.md"))) {
		fs.copyFileSync(join(from, "APPEND_SYSTEM.md"), join(to, "APPEND_SYSTEM.md"));
		results.push(["APPEND_SYSTEM.md", "global persona (layers under each repo's persona)"]);
	}

	// mcp.json -- the MCP servers jobs may connect (REQ-MCP-OPERATOR-SERVERS). REWRITTEN, never copied: only the servers
	// a job may connect are written, each in pi's shape with every header and env value a reference, so a host entry
	// with a literal value, an OAuth sign-in or a key this deployment does not take never reaches the overlay. Each one
	// left behind is named with why. The overlay's file follows the host's (`stageMcp`), since a job would otherwise
	// keep connecting servers the operator no longer offers.
	results.push(...stageMcp({ fs, from, to, skip: argv.includes("--no-mcp") }));

	// extensions/ -- the sharp edge, and copied BY DEFAULT: the operator staged this overlay to be their own
	// setup, and one they have to arm twice more is not that. The admin extension stays hard-blocked (it can
	// enqueue paid jobs from inside a container: a recursion vector, not part of this relaxation).
	//
	// Every copied name is listed, not just counted. What lands here runs in every job container from the
	// next job onward, so the operator gets ONE moment to read the actual names -- a bare "3 extensions" row
	// would leave them re-deriving the list from a directory they cannot see from the worker host.
	const extSrc = join(from, "extensions");
	if (withExtensions && fs.existsSync(extSrc)) {
		const { copied, blocked, disabled } = copyExtensions(fs, extSrc, join(to, "extensions"), out, hostPi.extensions.disabled);
		if (copied.length > 0) {
			results.push(["extensions/", `${copied.length} extension${copied.length === 1 ? "" : "s"} -- these LOAD in every job; VET THESE`]);
			// Note-less rows: the printer emits them bare, so the names read as a list under the count above.
			for (const name of copied) results.push([`  - ${name}`, ""]);
		}
		// Reported by OMISSION plus its own row, never as a suffix on a name row: the names above are the
		// vetting list, and a reader scanning it must not have to parse each line to learn what is live.
		if (disabled.length > 0) {
			results.push(["extensions (off)", `${disabled.length} disabled in your pi settings, not copied`]);
			for (const name of disabled) results.push([`  - ${name}`, ""]);
		}
		if (hostPi.extensions.unevaluated.length > 0) {
			out(
				`\nnote: ${hostPi.settingsPath} disables extensions with a pattern this command cannot evaluate,\n` +
					`  so these were copied and may be ones you turned off: ${hostPi.extensions.unevaluated.join(", ")}\n`,
			);
		}
		for (const name of blocked) out(`  blocked extension "${name}" — the admin extension must never run inside a job.\n`);
		out(
			"\n⚠ Extensions run code against adversarial input with open network egress and are NOT scanned for\n" +
				"  secrets. They load in every job as staged -- review every one listed below, and set\n" +
				"  PI_GLOBAL_ALLOW_EXTENSIONS=0 in .env if you need them off.\n",
		);
	} else if (fs.existsSync(extSrc)) {
		results.push(["extensions/", "skipped -- --no-extensions was passed (nothing from extensions/ reaches a job)"]);
	}

	// packages/ — pinned third-party pi packages, staged from npm on THIS host so the job container never
	// needs the network (issue #58). All-or-nothing: a failure leaves no half-staged set to load.
	if (withPackages) {
		// Discovered candidates split in two: the ones we can stage, and the ones we name a reason for. Both
		// are printed. A discovery that quietly ignored half the host's packages would be the same silent
		// no-op this feature exists to remove.
		const stageable = hostPi.packages.filter((p) => !p.skip);
		const byName = new Map(hostPi.packages.map((p) => [p.name, p]));
		const staged = await stagePackages({ fs, exec, out, packagesFile, to, platform, discovered: stageable, requireFile: !withHostPackages });
		if (staged.error) {
			out(`error: ${staged.error}\n`);
			return 1;
		}
		const n = staged.packages.length;
		results.push(["packages/", `${n} package${n === 1 ? "" : "s"} -- third-party code, VET THESE`]);
		const overrides = new Map(staged.overrides.map((o) => [o.name, o]));
		for (const entry of staged.packages) {
			const override = overrides.get(entry.name);
			const provenance = entry.from === FROM_HOST
				? "from your pi setup"
				: override
					? `from pi-packages.json, overrides your pi setup's ${override.host}`
					: "from pi-packages.json";
			results.push([`  - ${entry.name}@${entry.version} (${provenance})`, ""]);
		}
		for (const warn of staged.warnings) results.push([`packages/${warn.dir}`, `WARN: ${warn.reason}`]);
		// A package pi only partly loads still stages WHOLE: staging copies a directory, so "the package minus
		// one skill" is not expressible. Say that rather than pretend the host's filter travelled.
		for (const entry of staged.packages) {
			const host = entry.from === FROM_HOST ? byName.get(entry.name) : null;
			if (host && (host.filtered || host.autoload === false)) {
				results.push([`packages/${entry.dir}`, `WARN: your pi settings load only part of ${entry.name}; the overlay stages ALL of it`]);
			}
		}
		const skipped = [...hostPi.packages.filter((p) => p.skip).map((p) => ({ name: p.source, reason: p.skip })), ...staged.dropped];
		if (skipped.length > 0) {
			results.push(["host packages", `${skipped.length} skipped -- not staged`]);
			for (const item of skipped) results.push([`  - ${item.name} (${item.reason})`, ""]);
		}
		if (withHostPackages && hostPi.settingsState !== "ok") {
			results.push(["settings.json", hostSettingsNote(hostPi)]);
		}
	} else if (fs.existsSync(join(to, PACKAGES_SUBDIR))) {
		results.push(["packages/", "kept -- re-run with --with-packages to refresh"]);
	}

	out(`Imported the credential-free subset of ${from} → ${to}\n\n`);
	// A note-less row is a list item under the row above it (the extension names), so it prints bare rather
	// than padded out to a column that has nothing to hold.
	for (const [name, note] of results) out(note ? `  ${name.padEnd(18)} ${note}\n` : `  ${name}\n`);
	out(`\n  (auth.json, settings.json, sessions/ and mcp-auth.json are never copied: your credential stays in env/auth.json.)\n`);
	out(nextSteps(to, withExtensions, withPackages, withHostPackages && hostPi.packages.length > 0));
	return 0;
}

/**
 * Stage the host's `mcp.json` into the overlay, rewritten to the servers a job may connect. Returns the result rows.
 * The overlay's file follows the host's: it is replaced by each import, and removed when the host has none, when
 * `--no-mcp` is passed, or when the host offers no server a job may connect, so a hand-written overlay file is
 * replaced too (docs/mcp.md says so). One exception keeps what is there: a host file that cannot be read whole (not
 * JSON, a duplicate key, too large) changes nothing, since the operator is mid-edit and the last good list stands.
 * The overlay's file is never followed if it is a link: a new file is renamed over it, so a link back to the host's
 * own file cannot make this command rewrite it.
 */
function stageMcp({ fs, from, to, skip }) {
	const src = join(from, MCP_CONFIG_FILE_NAME);
	const dst = join(to, MCP_CONFIG_FILE_NAME);
	const rows = [];
	const existing = () => {
		try {
			return fs.lstatSync(dst);
		} catch {
			return null;
		}
	};
	const removeOld = (why) => {
		const entry = existing();
		if (entry === null) return true;
		if (entry.isDirectory()) {
			rows.push([`${MCP_CONFIG_FILE_NAME} (overlay)`, `WARN: ${dst} is a folder; remove it by hand`]);
			return false;
		}
		// unlink, not rmSync: `force` skips a dangling link, which the write would then follow.
		fs.unlinkSync(dst);
		rows.push([`${MCP_CONFIG_FILE_NAME} (overlay)`, `removed (${why})`]);
		return true;
	};
	if (skip) {
		if (fs.existsSync(src)) rows.push([MCP_CONFIG_FILE_NAME, "skipped -- --no-mcp was passed (jobs are offered no MCP server)"]);
		removeOld("--no-mcp");
		return rows;
	}
	if (!fs.existsSync(src)) {
		removeOld(`no ${MCP_CONFIG_FILE_NAME} in your pi setup`);
		return rows;
	}
	let parsed;
	try {
		// statSync follows a link, so a link to a regular file is read and one to a pipe or device is not: a FIFO would
		// block this read forever, and /dev/zero would never end.
		const stat = fs.statSync(src);
		if (!stat.isFile()) throw Object.assign(new Error(`${src}: is not a regular file`), { mcpConfig: true });
		if (stat.size > MCP_CONFIG_MAX_BYTES) throw Object.assign(new Error(`${src}: is larger than ${MCP_CONFIG_MAX_BYTES} bytes`), { mcpConfig: true });
		parsed = parseOverlayMcp(String(fs.readFileSync(src, "utf8")), src);
	} catch (error) {
		const kept = existing() === null ? "" : "; the overlay's file is kept as it was";
		rows.push([MCP_CONFIG_FILE_NAME, `SKIPPED -- ${error?.mcpConfig ? error.message : `${src}: cannot be read (${error?.code ?? "unreadable"})`}${kept}`]);
		return rows;
	}
	const names = Object.keys(parsed.servers);
	if (names.length > 0) {
		// Replaced, never written through: a link or an earlier file goes first, and a folder stops the write.
		const entry = existing();
		if (entry?.isDirectory()) {
			rows.push([MCP_CONFIG_FILE_NAME, `WARN: ${dst} is a folder; remove it by hand, then re-run`]);
		} else {
			// A new file renamed over the old: the rename replaces a link rather than its target, and a write that fails
			// leaves the last good list in place.
			// A name no earlier run left, opened only if it does not exist (`wx`), so it is never a link to follow; removed
			// again if the write or the rename fails, since every job mounts this folder.
			const tmp = `${dst}.${randomBytes(6).toString("hex")}.tmp`;
			try {
				fs.writeFileSync(tmp, overlayMcpText(parsed), { flag: "wx", mode: 0o644 });
				fs.renameSync(tmp, dst);
			} catch (error) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					// Never written.
				}
				throw error;
			}
			rows.push([MCP_CONFIG_FILE_NAME, `${names.length} MCP server${names.length === 1 ? "" : "s"} offered to jobs`]);
			for (const name of names) {
				const server = parsed.servers[name];
				const runner = server.packageRunner ? ", fetches its server from a registry at start" : "";
				rows.push([`  - ${name} (${server.transport}, ${mcpServerWhere(server)}${runner})`, ""]);
			}
		}
	} else {
		rows.push([MCP_CONFIG_FILE_NAME, "no MCP server a job may connect"]);
		removeOld("nothing to offer");
	}
	if (parsed.refused.length > 0) {
		rows.push([`${MCP_CONFIG_FILE_NAME} (left)`, `${parsed.refused.length} server${parsed.refused.length === 1 ? "" : "s"} not staged`]);
		for (const { name, problem } of parsed.refused) rows.push([`  - ${JSON.stringify(name)}: ${problem}`, ""]);
	}
	return rows;
}

/**
 * Copy `<src>/<name>/**` for each valid, non-symlink child dir. Returns the count copied.
 *
 * Delegates to the shared copier (issue #60), which is where the symlink guard actually works. The
 * guard here USED to be `fs.statSync(p).isSymbolicLink?.()`, and `statSync` FOLLOWS links, so it was
 * permanently false: a symlinked skill directory in `~/.pi/agent/skills` was staged as its target's
 * CONTENTS into an overlay that is :ro-mounted into every job container. `copySkillTree` uses lstat.
 *
 * Caps are off and source modes are preserved, so this command behaves exactly as it did apart from
 * the repair: the overlay is deploy-time operator config, not a per-job input, and a staged file that
 * changed mode would break a re-import (copyFileSync onto a 0444 file is EACCES).
 */
function copyNamedDirs(fs, src, dst, out) {
	if (!fs.existsSync(src)) return 0;
	const result = copySkillTree(src, dst, {
		fs,
		limits: null,
		mode: null,
		onSkip: (name, reason) => out(`  skipped "${name}" — ${reason === "symlink" ? "symlink" : "unexpected name"}\n`),
	});
	// "empty" is a refusal for a TRIGGER that asked for skills; here it just means the operator has
	// none, which is the ordinary case for a host that never wrote a skill.
	return result.refused ? 0 : result.dirs;
}

/**
 * Like copyNamedDirs but reports the admin extension it refuses to copy. Returns the NAMES copied, not a
 * count: the caller prints them, so the operator sees exactly what is now going into job containers.
 *
 * `hostDisabled` holds the names the operator turned off with `pi config` (issue #102). They are not copied,
 * and they are returned separately rather than merged into `copied`, because `copied` IS the vetting list and
 * a list that mixed live and inert entries would be worse than no list. Skipping them is a correction, not a
 * feature: until this landed, an extension explicitly disabled on the host still ran in every job container.
 */
function copyExtensions(fs, src, dst, out, hostDisabled = new Set()) {
	const copied = [];
	const blocked = [];
	const disabled = [];
	for (const name of fs.readdirSync(src)) {
		if (ADMIN_RE.test(name)) {
			blocked.push(name);
			continue;
		}
		if (!ENTRY_NAME_RE.test(name)) {
			out(`  skipped "${name}" — unexpected name\n`);
			continue;
		}
		if (hostDisabled.has(name)) {
			disabled.push(name);
			continue;
		}
		const childSrc = join(src, name);
		// lstat, NEVER stat: stat follows the link, so the old `statSync(p).isSymbolicLink?.()` here was
		// permanently false and a symlinked extension was staged as its target's contents (issue #60).
		const st = (fs.lstatSync ?? fs.statSync)(childSrc);
		if (st.isSymbolicLink?.()) continue;
		if (st.isDirectory()) copyTree(fs, childSrc, join(dst, name));
		else fs.copyFileSync(childSrc, join(dst, name));
		copied.push(name);
	}
	return { copied, blocked, disabled };
}

/**
 * Recursively copy one directory's contents, skipping symlinks (a symlink could point outside the
 * source). A thin adapter over the shared walker, so extensions and skills cannot drift apart on the
 * guard that matters: it is `lstat` there, where it used to be a `statSync` that followed every link.
 */
function copyTree(fs, src, dst) {
	copyDirContents(src, dst, { fs, limits: null, mode: null });
}

/**
 * Stage every package pinned in `packagesFile` into `<to>/packages/<dir>` and write the stage manifest.
 * Returns `{ packages, warnings, overrides, dropped }`, or `{ error }`.
 *
 * ALL-OR-NOTHING for DECLARED packages, because a half-staged set is worse than none: pi would load the
 * packages that made it and silently skip the rest (issue #58). Scoped to the declared set once discovery
 * landed (issue #102): a declared pin is a promise the operator made, so failing it still refuses everything,
 * but a discovered package is an inference WE made and it is DROPPED with a printed reason instead. Without
 * that split, discovery would multiply the entry count from two pins to twenty and one bad host package
 * would zero an overlay that was working. A named drop is not the silent skip the original rule forbade.
 *
 * Each package is installed into a private `.staging-<i>` dir, asserted there, and only renamed into place
 * once EVERY package has passed. A staged dir must be SELF-CONTAINED (`package.json` + its own
 * `node_modules/`) because at job time it is resolved from a read-only mount with no network and no
 * install step -- so every assertion below is about that property.
 *
 * `discovered` is what host-pi.mjs found in the operator's own pi setup (issue #102). Discovery adds
 * CANDIDATES, never exemptions: every assertion below runs on a discovered entry exactly as it does on a
 * declared one, and the merge that produced the list refused an admin package and a colliding dir using the
 * same validator the declared path uses.
 */
async function stagePackages({ fs, exec, out, packagesFile, to, platform = process.platform, discovered = [], requireFile = true }) {
	const haveFile = fs.existsSync(packagesFile);
	// The missing-file refusal is now conditional. With discovery on there is a second source of entries, so
	// no file simply means "nothing declared"; with `--no-host-packages` there is no other source and the
	// refusal is the same one it always was.
	if (!haveFile && requireFile) {
		return { error: `--with-packages needs a packages file, none at ${packagesFile}\n  Run \`pi-dispatch init\` to scaffold one, or pass --packages-file <path>.` };
	}

	let declared = [];
	if (haveFile) {
		try {
			declared = parsePackagesFile(fs.readFileSync(packagesFile, "utf8"), packagesFile);
		} catch (error) {
			// Refused before a single directory is created, so a bad file stages nothing at all.
			return { error: error.message };
		}
	}
	const { entries, overrides, dropped } = mergeHostPackages(declared, discovered);

	const packagesRoot = join(to, PACKAGES_SUBDIR);
	const rootExisted = fs.existsSync(packagesRoot);
	fs.mkdirSync(packagesRoot, { recursive: true });

	const npmBin = platform === "win32" ? "npm.cmd" : "npm";
	const stagingDirs = [];
	const prepared = [];
	const moved = [];
	const warnings = [];
	const softDropped = [];

	// One stage at a time on this overlay, also from another host on a shared home. Staging names are unique and nothing already
	// staged is touched, so a failure below cannot damage what jobs are loading: the manifest still names the old trees.
	const staged = await withStageLock({ fs, packagesRoot, holder: "import-pi" }, async () => {
		try {
			for (const entry of entries) {
				const staging = newStagingDir(packagesRoot);
				stagingDirs.push(staging);
				let source;
				try {
					source = await preparePackage({ fs, exec, out, entry, staging, npmBin, platform, warnings });
				} catch (error) {
					// The declared/discovered split: an entry the operator pinned is fatal, one we inferred from
					// their pi setup is dropped by name so the rest of the stage still lands.
					if (entry.from === FROM_HOST) {
						softDropped.push({ name: entry.name, reason: error.message });
						continue;
					}
					throw error;
				}
				prepared.push({ entry, source });
			}

			// Moves happen only after EVERY package has passed. Each goes to a new directory, so a failure on the last one
			// removes only what this run made, and what jobs are loading was never touched.
			const trees = new Map();
			for (const { entry, source } of prepared) {
				const dir = stagedTreeName(entry.dir, entry.version);
				// renameSync, never copyTree: copyTree's symlink guard uses statSync, which FOLLOWS links, so it
				// would copy the target of every node_modules/.bin symlink instead of skipping it.
				fs.renameSync(source, join(packagesRoot, dir));
				moved.push(join(packagesRoot, dir));
				trees.set(entry, dir);
			}
			// A dropped entry never made it into `prepared`, so it must not appear in the receipt either.
			const landed = entries.filter((entry) => trees.has(entry)).map((entry) => ({ ...entry, dir: trees.get(entry) }));
			// `from` and nothing more. This receipt is bind-mounted into every job container, so it must never carry
			// an install path off the operator's machine -- provenance is the fact doctor needs, the host path is not.
			const stageManifest = { stagedAt: new Date().toISOString(), packages: landed.map(({ name, version, dir, from }) => ({ name, version, dir, from })) };
			writeStageManifest({ fs, packagesRoot, manifest: stageManifest });
			pruneStagedTrees({ fs, packagesRoot, manifest: stageManifest });
			// A warning names its package's base directory, which only this stage knows the tree of.
			for (const warning of warnings) warning.dir = [...trees].find(([entry]) => entry.dir === warning.dir)?.[1] ?? warning.dir;
			return { landed };
		} catch (error) {
			for (const dest of moved) fs.rmSync(dest, { recursive: true, force: true });
			return { failed: error };
		} finally {
			for (const staging of stagingDirs) fs.rmSync(staging, { recursive: true, force: true });
		}
	}).catch((error) => ({ failed: error }));
	if (staged.failed) {
		if (!rootExisted && fs.readdirSync(packagesRoot).length === 0) fs.rmSync(packagesRoot, { recursive: true, force: true });
		return { error: `${staged.failed.message}\n  Nothing was staged -- fix ${packagesFile} (or the package) and re-run with --with-packages.` };
	}
	return { packages: staged.landed, warnings, overrides, dropped: [...dropped, ...softDropped] };
}

function flagValue(argv, flag) {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** The first argument that is neither a known flag nor the value of one, or null when argv is clean. */
function unknownFlag(argv) {
	for (let i = 0; i < argv.length; i++) {
		if (VALUE_FLAGS.has(argv[i])) {
			i++; // its value, whatever it is
			continue;
		}
		if (!BOOL_FLAGS.has(argv[i])) return argv[i];
	}
	return null;
}

/** Why discovery found nothing, when pi's settings file is the reason. */
function hostSettingsNote(hostPi) {
	if (hostPi.settingsState === "absent") return `none at ${hostPi.settingsPath} -- nothing discovered from your pi setup`;
	if (hostPi.settingsState === "packages-not-an-array") return `"packages" is not an array in ${hostPi.settingsPath} -- nothing discovered`;
	return `UNREADABLE at ${hostPi.settingsPath} -- host packages NOT discovered, extension state NOT applied`;
}

function nextSteps(to, withExtensions, withPackages, withHostPackages) {
	const steps = [`Set PI_GLOBAL_PI_DIR=${to} in .env`, "pi-dispatch doctor        # verifies the overlay is credential-free"];
	// The vetting step is no longer a switch to flip -- it already happened by staging. What is left is the
	// off switch, named here so an operator who does not want the extensions is not left hunting for it.
	if (withExtensions) steps.push("Vet the extensions listed above -- they load in every job; set PI_GLOBAL_ALLOW_EXTENSIONS=0 in .env to disable them");
	// Same inversion for packages: staging is what loads them, so the step worth naming is how to withhold
	// them from a trigger that should not run third-party code.
	if (withPackages) steps.push('Staged packages load in every job -- set `run.packages: false` on any trigger in triggers.json that must not load them');
	// Named here rather than only in the docs: this is the run whose meaning changed, so the operator who
	// wanted the old one should not have to go looking for how to get it back.
	if (withHostPackages) steps.push("Packages from your pi setup were staged too -- re-run with --no-host-packages to stage only what pi-packages.json declares");
	return `
Next:
${steps.map((step, i) => `  ${i + 1}. ${step}\n`).join("")}`;
}
