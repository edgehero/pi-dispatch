/**
 * The operator session's write guard (issue #504 part C; `DES-ADMIN-VIA-PI-EXTENSION`, `SECURITY.md`).
 *
 * The admin's confirm-gated tools are the model's door to the deployment's money files. pi's own built-in file tools
 * are a second door: a session that can call `write` or `edit` can rewrite `projects.json` or the allocation envelope
 * with no confirm at all, and with the envelope that is the operator's outer bound itself. So a `tool_call` handler
 * blocks the built-in mutating tools when their target IS one of the guarded files:
 *
 *   - the allocation envelope (`PI_ENVELOPE_FILE`), `projects.json`, `scoped-limits.json`, `triggers.json` and the
 *     settings overlay, at the paths this deployment resolves (the pointer and the deployment `.env` included), and
 *     the two files that NAME those paths, the deployment's `.env` and the pointer itself (index.ts `guardedFiles`,
 *     whose set only grows within a session);
 *   - not the overlay's `models.json`: the admin never writes it, so no tool's confirm is bypassed there.
 *
 * WHICH TOOLS is pinned against pi 0.99.1's `dist/core/tools/` (`allToolNames`) by a test: `write` and `edit` name
 * their target in `input.path`; `powershell` runs a command, judged by its text (a command that names a guarded file's
 * basename is blocked; one that builds the name at run time is not, a named residual); `bash` is NOT judged. An
 * operator's shell is the operator's own (`SECURITY.md`'s shell-access bullet), its commands are too free-form to read,
 * and blocking every mention of `projects.json` in it would block the operator's own `cat`. `read`, `grep`, `find` and
 * `ls` do not write.
 *
 * HOW A TARGET IS RESOLVED mirrors pi's own (`dist/core/tools/path-utils.js` `resolveToCwd`, over
 * `dist/utils/paths.js`): Unicode spaces become a plain space, one leading `@` is dropped, `~` and `~/` expand to the
 * home directory, a `file://` URL becomes its path, then the path is resolved against the call's `ctx.cwd`. pi exports
 * none of it, so the rules are copied, and a test pins them against the pinned source and against pi's function.
 *
 * WHICH FILE IT IS is decided by identity, never by the path string: an existing target is its `(dev, ino)` (stat
 * follows links), so a symlink to a guarded file, a hard link to it and, on a case-insensitive volume, a case variant
 * of its name are the guarded file. A target that does not exist yet is its nearest existing ancestor's `(dev, ino)`
 * plus the rest of the path, case-folded (`fold`): a dangling symlink on the way is followed as the kernel
 * would follow it when the file is created. The fold is applied on every volume, not only a case-insensitive one: on a
 * case-sensitive volume it also blocks creating `Projects.json` beside a missing `projects.json`, which costs nothing
 * and needs no probe of the volume. A resolution that fails for any other reason than "not there" BLOCKS (fail
 * closed), naming the code.
 *
 * NESTED CALLS are covered by pi itself: a codemode script's `ctx.executeTool` runs through the session's tool pipeline
 * with the same `tool_call` hooks (`dist/core/agent-session.js` `_executeNestedToolCall`), with `parentToolCallId` set.
 * The handler treats it like any other call. Residuals, named: a LATER extension that mutates `event.input.path`
 * after this handler ran (pi runs handlers in load order and does not re-validate), the operator's own `!` commands,
 * and `bash`.
 */

import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, resolve as nodeResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** pi's Unicode-space class (`dist/utils/paths.js` `UNICODE_SPACES`), copied; a test pins the literal. */
export const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** The built-in tools that write the file named by `input.path`. */
export const PATH_WRITE_TOOLS = Object.freeze(["write", "edit"]);
/** The built-in tool whose command text is judged (by the guarded files' basenames). */
export const JUDGED_COMMAND_TOOLS = Object.freeze(["powershell"]);
/** The built-in tools that are NOT judged, each for its reason above: `bash` (a named residual) and the four readers. */
export const UNJUDGED_TOOLS = Object.freeze(["bash", "read", "grep", "find", "ls"]);

/** pi's `normalizeWindowsShellPath` (`dist/utils/paths.js`), copied for win32: Git Bash, MSYS, Cygwin and WSL drive paths. */
function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * pi's `resolveToCwd(path, cwd)`, the path the built-in `write` and `edit` actually open: `normalizePath` with
 * `normalizeUnicodeSpaces` and `stripAtPrefix`, then `resolvePath` against `cwd` (itself normalized without those two).
 * `home` and `platform` are seams for the test that compares this with pi's own function.
 */
export function piResolveToCwd(input, cwd, { home = homedir(), platform = process.platform } = {}) {
  const normalize = (raw, { spaces, at }) => {
    let s = raw;
    if (spaces) s = s.replace(PI_UNICODE_SPACES, " ");
    if (at && s.startsWith("@")) s = s.slice(1);
    if (platform === "win32") s = normalizeWindowsShellPath(s);
    if (s === "~") return home;
    if (s.startsWith("~/") || (platform === "win32" && s.startsWith("~\\"))) return join(home, s.slice(2));
    if (/^file:\/\//.test(s)) return fileURLToPath(s);
    return s;
  };
  const target = normalize(String(input), { spaces: true, at: true });
  const base = normalize(String(cwd), { spaces: false, at: false });
  return isAbsolute(target) ? nodeResolve(target) : nodeResolve(base, target);
}

/** `(dev, ino)` of a bigint stat, the one identity a name, a link and a case variant of one file share. */
function idOf(st) {
  return `${st.dev}:${st.ino}`;
}

/**
 * The fold of a not-yet-existing path's tail, at least as wide as a case-insensitive volume's: NFKC (APFS is
 * normalization-insensitive, and NFKC also maps the KELVIN SIGN to K), then upper case before lower case, which is the
 * part a plain `toLowerCase` misses: U+017F LATIN SMALL LETTER LONG S upper-cases to S, and APFS treats `ſettings.json`
 * as `settings.json` (measured in review: a write of it created the real file). Folding WIDER than a volume only
 * blocks a name that differs from a guarded one by such a character, which costs nothing.
 */
export function fold(rest) {
  // Lower, upper, lower: U+1E9E LATIN CAPITAL LETTER SHARP S lowers to ß, which only upper-casing turns into SS, and
  // APFS folds it to "ss" (measured in review: `busineẞ-envelope.json` created `business-envelope.json`).
  return rest.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

/**
 * Does a command's text name `base` (a guarded file's basename) as a path segment? Both folded (`fold`), so a long s
 * or a sharp s cannot spell the name past the match, and matched only where no file-name character (a letter, a
 * digit, `.`, `_` or `-`) touches it on either side, so `.env` is not found in `process.env.HOME`, `.envrc` or
 * `.env.example` (review round 2). A best effort, as SECURITY.md says: a name built at run time passes, and so does an
 * 8.3 short name (`PROJEC~1.JSO`).
 */
export function commandNames(command, base) {
  const name = fold(String(base)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The tail allows trailing dots and spaces, which Windows strips from a name (`projects.json.` IS projects.json there,
  // review round 3), while `.env.example` still is not `.env`: after the dots, no file-name character may follow.
  return new RegExp(`(?<![\\p{L}\\p{N}._-])${name}(?=[. ]*(?![\\p{L}\\p{N}._-]))`, "u").test(fold(String(command)));
}

const GONE = new Set(["ENOENT", "ENOTDIR"]);
const MAX_LINKS = 40;

/**
 * The identity of the file an absolute path names, as the kernel would resolve it when the file is opened for writing:
 * `{ kind: "file", id }` for an existing file (links followed), or `{ kind: "new", id, rest }` for one that does not
 * exist yet: the nearest existing ancestor's identity and the folded path below it, with every symlink on the way
 * (a dangling one included) followed. THROWS on anything but "not there", for the caller to block on.
 */
export function targetIdentity(absPath, { fs = nodeFs } = {}) {
  try {
    return { kind: "file", id: idOf(fs.statSync(absPath, { bigint: true })) };
  } catch (err) {
    if (!GONE.has(err?.code)) throw err;
  }
  let path = nodeResolve(absPath);
  for (let hops = 0; hops <= MAX_LINKS; hops++) {
    const { root } = parsePath(path);
    const segments = path.slice(root.length).split(sep).filter(Boolean);
    let cur = root;
    let restarted = false;
    for (let i = 0; i < segments.length; i++) {
      const next = join(cur, segments[i]);
      let st;
      try {
        st = fs.lstatSync(next);
      } catch (err) {
        if (!GONE.has(err?.code)) throw err;
        return { kind: "new", id: idOf(fs.statSync(cur, { bigint: true })), rest: fold(segments.slice(i).join("/")) };
      }
      if (st.isSymbolicLink()) {
        // Followed as the kernel follows it on create: the link's text, against the directory holding the link.
        path = nodeResolve(dirname(next), fs.readlinkSync(next), ...segments.slice(i + 1));
        restarted = true;
        break;
      }
      cur = next;
    }
    if (!restarted) {
      // Every component exists, yet the first stat said it does not: it vanished in between. Judge it again as a file.
      return { kind: "file", id: idOf(fs.statSync(path, { bigint: true })) };
    }
  }
  const loop = new Error("too many symbolic links on the way");
  loop.code = "ELOOP";
  throw loop;
}

/** The keys of a `.env` that name a guarded file, with the label and the tool a blocked call is pointed at. */
export const GUARDED_ENV_KEYS = Object.freeze({
  PI_ENVELOPE_FILE: { label: "the allocation envelope (PI_ENVELOPE_FILE)", tool: "dispatch_envelope_set" },
  PI_PROJECTS_FILE: { label: "projects.json (PI_PROJECTS_FILE)", tool: "dispatch_project_add, _edit or _delete" },
  PI_SCOPED_LIMITS_FILE: { label: "scoped-limits.json (PI_SCOPED_LIMITS_FILE)", tool: "dispatch_limit_add, _edit or _delete" },
  PI_TRIGGERS_FILE: { label: "triggers.json (PI_TRIGGERS_FILE)", tool: "dispatch_trigger_add, _edit or _delete" },
  PI_SETTINGS_FILE: { label: "the settings overlay (PI_SETTINGS_FILE)", tool: "dispatch_set" },
});

/** The most of a `.env` the guard reads: far above any real one, far below what a device or a huge file could cost. */
export const ENV_READ_MAX = 1024 * 1024;

/**
 * A regular file's text, or null, NEVER hanging and never reading more than `max` bytes (review round 3). Opened
 * O_NONBLOCK, so a FIFO planted as `.env` cannot block the open; `fstat` on the descriptor, so the check is of the
 * file that was opened, not of a name that can be swapped; a regular file only (a FIFO, `/dev/zero` behind a symlink,
 * a directory is null) and at most `max` bytes (a larger one is null, not a prefix); read through that descriptor.
 * A link to a regular file is followed, as a service's loader follows it. Any failure is null.
 */
export function readSmallRegularFile(path, { fs = nodeFs, max = ENV_READ_MAX } = {}) {
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(Math.min(Number(st.size), max) + 1);
    let n = 0;
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > max) return null; // it grew past the cap while being read
    }
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * The guarded files a folder's `.env` NAMES, and that `.env` itself when it names any (issue #504 part C, review rounds
 * 2 and 3): a deployment built with `init` and `up` and no pointer keeps its paths in its own `.env`, which the panel
 * does not read for configuration (`panelEnv` reads the pointer's folder alone, gate round 1 of issue #471, because a
 * repository can commit a `.env`). So this read may only ADD to the guard, never change what the panel connects to
 * or writes, and it OVER-reads on purpose: a wrongly guarded file costs a refused write, a missed one the bound.
 *
 * For the LAST assignment of each guarded key (`KEY=value`, an `export` prefix allowed; the loaders take the last), it
 * adds every reading a service loader might make of the value: as written, without a trailing ` # comment`, without
 * one surrounding pair of quotes, with every quote removed (`/dep/"projects".json`), and each of those with a leading
 * `~`, `$HOME` or `${HOME}` expanded to `home`. A relative reading resolves against `dir`, the folder the service
 * runs in. Other expansions (`$OTHER`, command substitution) are not followed: a deployment that builds its paths
 * that way is guarded only through the keys the panel itself sees. Read through `readSmallRegularFile`, so a FIFO or a
 * device planted as `.env` adds nothing and cannot hang the session. Never throws.
 */
export function envNamedFiles(dir, { fs = nodeFs, home = homedir() } = {}) {
  const text = readSmallRegularFile(join(dir, ".env"), { fs });
  if (text === null) return [];
  const last = new Map();
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(PI_[A-Z_]+_FILE)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && Object.hasOwn(GUARDED_ENV_KEYS, m[1])) last.set(m[1], m[2]);
  }
  const out = [];
  for (const [key, raw] of last) {
    const readings = new Set();
    for (const v of [raw, raw.replace(/\s+#.*$/, "")]) {
      for (const w of [v, v.replace(/^(["'])(.*)\1$/, "$2"), v.replace(/["']/g, "")]) {
        readings.add(w);
        readings.add(w.replace(/^(?:~(?=\/|$)|\$HOME(?![A-Za-z0-9_])|\$\{HOME\})/, home));
      }
    }
    for (const r of readings) if (r.trim() !== "") out.push({ path: nodeResolve(dir, r), ...GUARDED_ENV_KEYS[key] });
  }
  if (out.length > 0) out.push({ path: join(dir, ".env"), label: "the deployment's .env, which names these files (PI_*_FILE)", tool: "the operator's own editor" });
  return out;
}

/** Two identities name one file: the same existing file, or the same not-yet-existing name under the same directory. */
function sameFile(a, b) {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind === "file" || a.rest === b.rest;
}

/**
 * The `tool_call` handler. `guardedFiles()` returns `[{ path, label }]`, read per call so a pointer or `.env` change
 * reaches the next call (`label` names the file and its tool, never a full path, for the reason the model sees).
 * Returns `{ block: true, reason }` or undefined. NEVER throws: an error is a block (pi treats a throw as a block too,
 * but with a reason this module did not choose).
 */
export function makeWriteGuard({ guardedFiles, fs = nodeFs, home = homedir(), platform = process.platform, processCwd = () => process.cwd() }) {
  return function writeGuard(event, ctx) {
    const tool = event?.toolName;
    const judgedPath = PATH_WRITE_TOOLS.includes(tool);
    const judgedCommand = JUDGED_COMMAND_TOOLS.includes(tool);
    if (!judgedPath && !judgedCommand) return undefined;
    let guarded;
    try {
      guarded = (guardedFiles() ?? []).filter((g) => typeof g?.path === "string" && g.path !== "");
    } catch (err) {
      return { block: true, reason: `pi-dispatch could not read which files it guards (${codeOf(err)}), so this ${tool} is blocked; run /dispatch to see why` };
    }
    if (guarded.length === 0) return undefined;
    if (judgedCommand) {
      const command = String(event?.input?.command ?? "");
      const hit = guarded.find((g) => commandNames(command, baseName(g.path)));
      return hit ? blocked(tool, hit) : undefined;
    }
    const raw = event?.input?.path;
    if (typeof raw !== "string" || raw === "") {
      return { block: true, reason: `pi-dispatch blocked this ${tool}: its path is not a string, so it cannot tell which file it writes` };
    }
    try {
      const abs = piResolveToCwd(raw, typeof ctx?.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : processCwd(), { home, platform });
      const target = targetIdentity(abs, { fs });
      for (const g of guarded) {
        let id;
        try {
          id = targetIdentity(nodeResolve(processCwd(), g.path), { fs });
        } catch {
          // A guarded file this process cannot resolve: judged by its name instead, folded, which still catches the
          // spelling the operator configured.
          if (fold(abs) === fold(nodeResolve(processCwd(), g.path))) return blocked(tool, g);
          continue;
        }
        if (sameFile(target, id)) return blocked(tool, g);
      }
      return undefined;
    } catch (err) {
      return { block: true, reason: `pi-dispatch blocked this ${tool}: it could not resolve the target path (${codeOf(err)}), and a write it cannot place could be one of the deployment's guarded files` };
    }
  };
}

function baseName(p) {
  return parsePath(String(p)).base;
}

function codeOf(err) {
  return typeof err?.code === "string" ? err.code : "error";
}

function blocked(tool, g) {
  return {
    block: true,
    reason: `pi-dispatch blocked this ${tool}: it writes ${g.label}, which only the operator changes (${g.tool ? `the way to ask: ${g.tool}` : "by hand"}). Ask the operator instead.`,
  };
}
