/**
 * `/dispatch console [page] [--link [name]] [--no-link] [--no-open]` (issue #708): from pi to the operator console in one step.
 * It prints the page's address (`consolePageLines`, the rules `/dispatch insights` uses), says whether the console is
 * running (the worker's `console-probe.mjs`, the one rule doctor uses too: one `GET /healthz` to this host's loopback or
 * the socket and nowhere else), with `--link` mints a one-time sign-in code for an operator token (and since issue #849
 * does so by default, with neither flag, where the choice is plain), and on a local session opens the browser.
 *
 * AN OPERATOR-TYPED COMMAND, NEVER A TOOL (DES-ADMIN-VIA-PI-EXTENSION). A sign-in link is a login to the console as an
 * operator, so nothing here reaches model context: every word goes to `notify`, which is the operator's alone, and
 * nothing calls `send`. A ctx without a UI (print and json mode) is refused before anything is probed or minted, since
 * its notice would have nowhere to go. RPC mode HAS a UI (`hasUI` is true there), but its `notify` goes to the RPC
 * client, another program and possibly another machine, so the address and the state are shown there and `--link` is
 * refused: a sign-in link is for the operator's own terminal (`ctx.mode`, `"tui"`, `"rpc"`, `"json"` or `"print"` at
 * the pinned pi).
 *
 * THE PANEL IS A SECOND MINTER of login codes, beside `pi-dispatch-console link`, and the same trust: the panel runs
 * as the deployment account, which can read the tokens file and write the code drop anyway. It differs in one rule,
 * the panel's own (`audited-write.mjs`): the audit row is appended BEFORE the code exists, and a code whose row cannot
 * be appended is never made. The CLI appends after, for its own reasons (a shell command's change has happened by
 * then); the panel's rule is the stricter one, so a link that works is always one the log holds.
 *
 * THE BROWSER OPENS by default on a local session only (`isLocalBrowserSession`: no SSH variable, a desktop opener or a
 * display), and only for a TCP listener at a concrete address: a socket is reached through a tunnel this command cannot
 * open, and `<this host>` is no address to open. `--no-open` keeps it closed. The URL is printed always, because the
 * printed URL is the contract and the browser a convenience (`open-browser.mjs`). With `--link` the opened URL carries
 * the code, so the opener is handed a private redirect page's path, never the link (`open-link.mjs`: an opener's argv
 * is readable by every local account while it runs).
 *
 * A LINK IS MADE ONLY WHERE THE GUARD STANDS: the drop the code is written to is the one `guardedFiles()` guards
 * (`deps.guarded`), so a session whose deployment the panel cannot see (where nothing is guarded) never mints into a
 * directory its own `write` could plant codes in. And only for a console the probe found running: a code expires 60
 * seconds after it is made, and "unknown" is no promise anyone will spend it.
 *
 * Pi-free: index.ts hands in the deployment's env, paths and the ctx's UI; the tests hand in fakes for each seam.
 */
import { keptTokens, readTokensFile } from "@edgehero/pi-dispatch/console-tokens";
import { isLocalBrowserSession, openBrowser } from "@edgehero/pi-dispatch/open-browser";
import { panelActor, panelAudit, writeTicket } from "./audited-write.mjs";
import { consolePageLines, consolePageUrl } from "./console/link.mjs";
import { keptTokenLinkRefusal, loginCodesDir, mintLoginCode, operatorNames } from "./console/login-codes.mjs";
import { openLinkViaFile } from "./console/open-link.mjs";
import { probeConsole } from "@edgehero/pi-dispatch/console-probe";
import { CONSOLE_START_ADVICE } from "./console/link.mjs";
import { RUN_ID_RE } from "./read-model.mjs";
import * as nodeFs from "node:fs";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { DEFAULT_LISTEN } from "./console/config.mjs";
import { parseListen } from "./console/listen.mjs";

export const CONSOLE_USAGE = "usage: /dispatch console [setup|runs|fleet|insights|config|parked|audit|<run id>] [--link [token name]] [--no-link] [--no-open]";

/** The page words the command takes, each the console page of that name. Anything else that is a run id is `run?id=`. */
export const CONSOLE_PAGE_WORDS = Object.freeze(["setup", "runs", "fleet", "insights", "config", "parked", "audit"]);

/** How to make an operator token, said when `--link` finds none. */
const TOKEN_ADD_HINT = "add one in the operator's own shell with pi-dispatch-console token add --name <name> --role operator";

/**
 * The words after `console`: `{ page, link, noLink, name, noOpen }` or `{ usage: true }`. The word right after `--link` is
 * the token's name unless it is a flag, so a page goes before `--link` (`/dispatch console runs --link alice`). `--no-link`
 * (issue #849) turns off the link the command makes by default where the choice is plain; with `--link` it is a usage error.
 */
export function parseConsoleArgs(words) {
  let page = null;
  let link = false;
  let noLink = false;
  let name = null;
  let noOpen = false;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--link") {
      if (link) return { usage: true };
      link = true;
      const next = words[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        name = next;
        i += 1;
      }
    } else if (w === "--no-link") {
      if (noLink) return { usage: true };
      noLink = true;
    } else if (w === "--no-open") {
      if (noOpen) return { usage: true };
      noOpen = true;
    } else if (w.startsWith("-") || page !== null) {
      return { usage: true };
    } else {
      page = w;
    }
  }
  if (link && noLink) return { usage: true };
  return { page, link, noLink, name, noOpen };
}

/**
 * A page word as the console path it opens (no leading `/`, a query allowed): `""` for the overview, `runs`, ...,
 * `run?id=<id>` for a run id; null for anything else. The run id charset is the read model's (`RUN_ID_RE`), which the
 * console's `/run` page holds an id to, so a path printed here is one the page accepts.
 */
export function consolePagePath(page) {
  if (page === null || page === undefined) return "";
  if (CONSOLE_PAGE_WORDS.includes(page)) return page;
  if (RUN_ID_RE.test(page)) return `run?id=${page}`;
  return null;
}

/**
 * `<url>` a fragment value: the characters that would end it or be read as another part (`%`, `&`, `#`, `+`, a space)
 * percent-encoded, the rest as it is, so `/run?id=a.b` stays readable in the printed link.
 */
function fragmentValue(text) {
  return text.replace(/[%&#+\s]/g, (c) => encodeURIComponent(c));
}

/** An address as the console parses it, so two spellings of one address compare equal (a refusal compares as itself). */
function addressKey(value, platform) {
  const text = String(value ?? "").trim() || DEFAULT_LISTEN;
  const parsed = parseListen(text, { bindPublic: true, platform });
  if (parsed.refusal) return `refused ${text}`;
  // An IPv6 host in its one canonical form, so `[0:0:0:0:0:0:0:1]` is `[::1]`, as the socket it binds is. A zone id
  // (`[fe80::1%en0]`, which the console accepts) is no URL host, so such an address compares as written.
  let host = parsed.host ?? null;
  if (typeof host === "string" && host.includes(":")) {
    try {
      host = new URL(`http://[${host}]/`).hostname;
    } catch {
      // as written
    }
  }
  return JSON.stringify([parsed.kind, host, parsed.port ?? null, parsed.path ?? null]);
}

/**
 * A line as a terminal may show it: a control character (an escape sequence in a folder's name, which a path, the
 * trust reader's reason or an error message can carry) as `?`. Applied to the whole answer, not to each path in it.
 */
const shown = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

/**
 * Whether the console this address names is the one whose tokens file the panel would mint into (issue #849's
 * follow-up). The address is the deployment env's `PI_CONSOLE_LISTEN`, where an export in pi's environment outranks
 * the folder's `.env`; the tokens file is the folder's (the pointer's, or the deployment folder pi was started in). With
 * no pointer, or with that export, the two can name two deployments on one machine, and a code minted into one drop is
 * refused by the other console: safe, but a sign-in that fails. So the default link is made only when the folder's
 * `.env` names this same address (read for that one key, to compare, never to use). A `.env` that cannot be read or
 * trusted, names the key in a form the service's loader may read differently, or holds a line the shell runs rather
 * than reads (which can set it unseen), cannot tell, and skips it too. A tokens file outside the folder (one pi's
 * environment names elsewhere with `PI_CONSOLE_TOKENS_FILE`) is no folder's, and the panel passes no folder: the check
 * is not made.
 * `exported` says the address came from pi's own environment, which decides the advice: a pointer (`/dispatch setup`)
 * makes the panel read the folder's `.env`, but an export outranks it. Returns undefined with no folder (the drop guard
 * decides then), else `{ same: true }` or `{ same: false, why, hint }`; in every case `./pi-dispatch console`, run in
 * that folder, signs in to that folder's own console.
 */
export function consoleDeploymentCheck({ env, folder, exported = false, platform = process.platform, readFolder = (dir) => deploymentServiceEnv({ env: {}, dir, keys: ["PI_CONSOLE_LISTEN"], platform, fs: nodeFs }) } = {}) {
  if (typeof folder !== "string" || folder === "") return undefined;
  const res = readFolder(folder);
  // A line the shell loader runs rather than reads (`. ./more.env`, macOS's loader) can set the key without spelling it,
  // which the console's own reader treats as a hazard too (console/cli.mjs), so it cannot tell either.
  const unknown = res.unreadable ? `could not be read (${res.unreadable})` : res.untrusted ? res.untrusted : (res.unread ?? []).length > 0 || (res.hazardSkipped ?? []).length > 0 ? "has a line its service may read differently, and it could set PI_CONSOLE_LISTEN" : res.shellRunsLine != null ? `line ${res.shellRunsLine} is run by the shell rather than read, and could set PI_CONSOLE_LISTEN` : null;
  const fallback = `or run ./pi-dispatch console in ${folder}`;
  if (unknown) return { same: false, why: shown(`${res.path} ${unknown}, so whether this console is the one its tokens file signs in to cannot be told`), hint: shown(`fix that line, ${fallback}`) };
  const declared = res.env?.PI_CONSOLE_LISTEN;
  const here = env?.PI_CONSOLE_LISTEN;
  if (addressKey(here, platform) === addressKey(declared, platform)) return { same: true };
  const say = (value) => (String(value ?? "").trim() ? String(value).trim() : `the default ${DEFAULT_LISTEN}`);
  const theirs = say(declared);
  return {
    same: false,
    why: shown(`${res.path} puts this deployment's console at ${theirs}, but this pi opens ${say(here)}${exported ? " (PI_CONSOLE_LISTEN in pi's environment)" : ""}, and that console would refuse a code made for this folder`),
    hint: shown(exported ? `unset PI_CONSOLE_LISTEN in pi's environment or set it to ${theirs}, ${fallback}` : `run /dispatch setup so this pi reads that folder's settings, ${fallback}`),
  };
}

/** The one line a probe answer reads as. */
export function probeLine(answer) {
  if (answer?.state === "running") return "running";
  if (answer?.state === "not-running") return `not running${answer.reason ? ` (${answer.reason})` : ""}: ${CONSOLE_START_ADVICE}`;
  return `whether it runs is not known: ${answer?.reason ?? "it was not asked"}`;
}

/**
 * Run the command. `deps`:
 *   - `hasUI`, `mode` (pi's `ctx.mode`), `notify(text, level)`, `select(title, options)` (pi's `ctx.ui.select`,
 *     already gated);
 *   - `env`, the deployment's env (`PI_CONSOLE_LISTEN`, `PI_CONSOLE_BIND_PUBLIC`); `sessionEnv`, this process's env
 *     (the SSH and display variables); `platform`;
 *   - `logsDir` (the audit log's), `tokensPath` (the console tokens file, or null where the panel guards none),
 *     `guarded(dir)` (is `dir` a directory `guardedFiles()` guards now) and `deployment` (`consoleDeploymentCheck`'s
 *     answer: whether the address and the tokens file are one deployment's, which only the default link reads);
 *   - seams: `probe(env, opts)` (the worker's `probeConsole`), `request` (its `http.request` seam), `readTokens()`, `audit` (`{ append(row) }`), `actor`, `ticket`, `mint({ dir, name })`,
 *     `open(url)` (the opener for a URL with no code), `openLink(url)` (for one with a code, `openLinkViaFile`),
 *     `isLocal({ env, platform })`.
 * Returns what it did, for the tests: `{ refused }`, or `{ state, url, opened, minted }`.
 */
export async function consoleCommand(words, deps) {
  const notify = deps.notify ?? (() => {});
  if (!deps.hasUI) {
    notify("/dispatch console needs pi's interactive UI: its address, its state and any sign-in link are shown to the operator only, never into the conversation", "warning");
    return { refused: "no-ui" };
  }
  const args = parseConsoleArgs(words);
  const path = args.usage ? null : consolePagePath(args.page);
  if (args.usage || path === null) {
    notify(CONSOLE_USAGE, "warning");
    return { refused: "usage" };
  }
  const env = deps.env ?? {};
  const platform = deps.platform ?? process.platform;
  const probe = deps.probe ?? probeConsole;
  const at = consolePageUrl(env, path, { platform });
  const answer = await probe(env, deps.request ? { request: deps.request } : {});
  const lines = at.refusal ? consolePageLines(env, path, { platform }) : [consolePageLines(env, path, { platform })[0]];
  lines.push(`the console: ${probeLine(answer)}`);

  let url = at.url && !at.anyHost ? at.url : null;
  let minted = false;
  // Issue #849: with neither flag, the link is made by default where the choice is plain (pi's terminal UI, a running console, one operator token,
  // a guarded drop), and otherwise the command says what it always said, with no refusal: `--link` is for choosing among operators or naming one.
  // Once it has decided to mint, a failure (the audit row, the mint) is said either way: a person is waiting for a sign-in.
  const auto = !args.link && !args.noLink;
  let skippedLevelOut = "info";
  const isLocal = deps.isLocal ?? isLocalBrowserSession;
  const local = isLocal({ env: deps.sessionEnv ?? process.env, platform });
  if (args.link || auto) {
    const SKIP = Symbol("no link");
    // In the default, every reason not to link is said in one line and the page is still opened; only an asked-for `--link` refuses.
    let skipped = null;
    // Set once it has decided to mint: a failure then is a fault (the audit log, the drop), said as a warning, never the dim status line.
    let decided = false;
    let skippedLevel = "info";
    const refuse = (why, hint = null, { fault = false } = {}) => {
      if (auto) {
        skipped = `no sign-in link was made: ${why}${hint ? `; ${hint}` : ""}`;
        if (decided || fault) skippedLevel = "warning";
        return SKIP;
      }
      notify([...lines, `no sign-in link was made: ${why}`].join("\n"), "warning");
      return { refused: "link", state: answer.state };
    };
    const linked = await (async () => {
      // The default makes a link only for a browser it will hand it to: a code printed for nobody would sit in the scrollback for 60 seconds.
      // Windows refuses the login-code drop (its ACLs cannot be judged), so the default never decides to mint there; `--link` says so as a refusal.
      if (auto && platform === "win32") return refuse("one-time links do not work on a Windows host; paste a token");
      if (auto && (args.noOpen || !local || at.socket || at.anyHost)) return refuse(args.noOpen ? "--no-open asks for the address alone" : !local ? "nothing here would open it" : "this console is reached through a tunnel or another host, so nothing here would open it", "/dispatch console --link prints one");
      // `"tui"` exactly: a pi too old to say its mode is not known to be the operator's terminal either.
      if (deps.mode !== "tui") return refuse(`pi runs in ${deps.mode ?? "an unknown"} mode here, where a notice goes to another program, not the operator's terminal; run /dispatch console --link in pi's terminal UI, or pi-dispatch-console link in a shell`);
      if (at.refusal || at.ephemeral) return refuse("the console's address is not known here, so a link could not name it; run pi-dispatch-console link --name <name> where the console runs");
      if (answer.state !== "running") return refuse(answer.state === "not-running" ? "the console is not running, and a code expires 60 seconds after it is made" : "the console could not be confirmed running, and a code expires 60 seconds after it is made; start it, or run pi-dispatch-console link where it runs");
      // Mint only into a drop the write guard holds, so this session's own `write` could not have planted a code there.
      const codesDir = typeof deps.tokensPath === "string" && deps.tokensPath !== "" ? loginCodesDir(deps.tokensPath) : null;
      if (codesDir === null || typeof deps.guarded !== "function" || !deps.guarded(codesDir)) {
        return refuse("the panel does not see this deployment's tokens file, so it guards no login-code directory to mint into; run /dispatch setup (a deployment pointer), or start pi in the deployment folder, or use pi-dispatch-console link in a shell");
      }
      // The default never mints for a console that is not the tokens file's, and says so as a warning: the page it opens
      // is another deployment's. An asked-for `--link` still mints, as before, with the same warning above its link.
      if (deps.deployment?.same === false) {
        if (auto) return refuse(deps.deployment.why, deps.deployment.hint, { fault: true });
        lines.push(`warning: ${deps.deployment.why}; the link below may be refused (${deps.deployment.hint})`);
        skippedLevelOut = "warning";
      }
      const read = (deps.readTokens ?? (() => readTokensFile({ path: deps.tokensPath })))();
      if (read.refusal) return refuse(`${read.refusal}; ${TOKEN_ADD_HINT}`);
      const operators = operatorNames(read.file);
      let name = args.name;
      if (name !== null) {
        const entry = read.file.tokens.find((t) => t.name === name);
        // Issue #761: a name the file keeps for a role this console does not know is no missing token; it is refused as
        // `pi-dispatch-console link` refuses it.
        const kept = entry ? undefined : keptTokens(read.file).find((t) => t.name === name);
        if (kept) return refuse(keptTokenLinkRefusal(kept));
        if (!entry) return refuse(`there is no token named "${name}"; see pi-dispatch-console token list`);
        if (entry.role !== "operator") return refuse(`"${name}" is a ${entry.role} token, and the panel signs in operators only; use pi-dispatch-console link --name ${name} in a shell for it`);
      } else if (operators.length === 0) {
        return refuse(`the tokens file holds no operator token; ${TOKEN_ADD_HINT}`);
      } else if (operators.length === 1) {
        name = operators[0];
      } else if (auto) {
        return refuse(`the tokens file holds ${operators.length} operator tokens`, "/dispatch console --link picks one");
      } else {
        if (typeof deps.select !== "function") return refuse(`the tokens file holds ${operators.length} operator tokens; name one: /dispatch console --link <name>`);
        const picked = await deps.select("Sign in to the console as which operator token?", operators);
        if (typeof picked !== "string" || !operators.includes(picked)) {
          notify([...lines, "no sign-in link was made: no token was chosen"].join("\n"), "info");
          return { refused: "cancelled", state: answer.state };
        }
        name = picked;
      }
      decided = true;
      // Audit, then mint (the panel's rule): a code with no row in the log is never made.
      // One ticket on both rows, as `auditedWrite` does, so a reader ties a `failed` row to its `ok` row.
      const audit = deps.audit ?? panelAudit(deps.logsDir);
      const ticket = deps.ticket ?? writeTicket();
      try {
        audit.append({ actor: deps.actor ?? panelActor(), action: "login-code", target: name, outcome: "ok", ticket });
      } catch (e) {
        return refuse(`the audit log could not be written (${typeof e?.code === "string" ? e.code : "error"}), so no code was made; check PI_LOGS_DIR`);
      }
      const mint = deps.mint ?? ((o) => mintLoginCode(o));
      const made = mint({ dir: codesDir, name });
      if (made.refusal) {
        // The row says ok and no code exists: the safe direction to be wrong in, and said here.
        try {
          audit.append({ actor: deps.actor ?? panelActor(), action: "login-code", target: name, outcome: "failed", reason: made.refusal, ticket });
        } catch {
          // the refusal below is what the operator must see
        }
        return refuse(made.refusal);
      }
      minted = true;
      const next = path === "" ? "" : `&next=${fragmentValue(`/${path}`)}`;
      if (at.socket) {
        lines.push(`sign-in link for "${name}" (through that tunnel; it works once, within 60 seconds): http://localhost:4790/login/code#${made.code}${next}`);
      } else {
        const base = at.url.slice(0, at.url.length - path.length);
        const link = `${base}login/code#${made.code}${next}`;
        lines.push(`sign-in link for "${name}" (it works once, within 60 seconds): ${link}`);
        url = at.anyHost ? null : link;
      }
      return null;
    })();
    if (linked === SKIP) {
      lines.push(skipped);
      skippedLevelOut = skippedLevel;
    }
    else if (linked !== null) return linked;
  }

  let opened = false;
  if (url !== null && answer.state === "running") {
    if (args.noOpen) {
      // Said nothing: the operator asked for the URL alone.
    } else if (local) {
      if (minted) {
        const o = (deps.openLink ?? ((u) => openLinkViaFile(u, { open: deps.open ?? openBrowser })))(url);
        if (o?.refusal) lines.push(o.refusal);
        else opened = true;
      } else {
        (deps.open ?? openBrowser)(url);
        opened = true;
      }
      // "Handed to", not "opened in": the opener is told, and whether the browser shows the page is the browser's. On
      // Linux a snap or Flatpak browser has a /tmp of its own, so the private page is "not found" there.
      if (opened) lines.push(minted && platform !== "darwin" && platform !== "win32" ? "handed to your browser (a snap or Flatpak browser cannot read the page in /tmp and shows it as not found: open the link above instead)" : "handed to your browser");
    } else {
      lines.push("not opened: this is not a local session (SSH, or no display), so open the URL yourself");
    }
  }
  notify(lines.join("\n"), answer.state === "not-running" || skippedLevelOut === "warning" ? "warning" : "info");
  return { state: answer.state, url, opened, minted };
}
