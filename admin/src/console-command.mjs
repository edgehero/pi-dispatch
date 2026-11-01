/**
 * `/dispatch console [page] [--link [name]] [--no-open]` (issue #708): from pi to the operator console in one step.
 * It prints the page's address (`consolePageLines`, the rules `/dispatch insights` uses), says whether the console is
 * running (the worker's `console-probe.mjs`, the one rule doctor uses too: one `GET /healthz` to this host's loopback or
 * the socket and nowhere else), with `--link` mints
 * a one-time sign-in code for an operator token, and on a local session opens the browser.
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
import { readTokensFile } from "@edgehero/pi-dispatch/console-tokens";
import { isLocalBrowserSession, openBrowser } from "@edgehero/pi-dispatch/open-browser";
import { panelActor, panelAudit, writeTicket } from "./audited-write.mjs";
import { consolePageLines, consolePageUrl } from "./console/link.mjs";
import { loginCodesDir, mintLoginCode } from "./console/login-codes.mjs";
import { openLinkViaFile } from "./console/open-link.mjs";
import { probeConsole } from "@edgehero/pi-dispatch/console-probe";
import { CONSOLE_START_ADVICE } from "./console/link.mjs";
import { RUN_ID_RE } from "./read-model.mjs";

export const CONSOLE_USAGE = "usage: /dispatch console [setup|runs|fleet|insights|config|parked|audit|<run id>] [--link [token name]] [--no-open]";

/** The page words the command takes, each the console page of that name. Anything else that is a run id is `run?id=`. */
export const CONSOLE_PAGE_WORDS = Object.freeze(["setup", "runs", "fleet", "insights", "config", "parked", "audit"]);

/** How to make an operator token, said when `--link` finds none. */
const TOKEN_ADD_HINT = "add one in the operator's own shell with pi-dispatch-console token add --name <name> --role operator";

/**
 * The words after `console`: `{ page, link, name, noOpen }` or `{ usage: true }`. The word right after `--link` is the
 * token's name unless it is a flag, so a page goes before `--link` (`/dispatch console runs --link alice`).
 */
export function parseConsoleArgs(words) {
  let page = null;
  let link = false;
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
    } else if (w === "--no-open") {
      if (noOpen) return { usage: true };
      noOpen = true;
    } else if (w.startsWith("-") || page !== null) {
      return { usage: true };
    } else {
      page = w;
    }
  }
  return { page, link, name, noOpen };
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
 *   - `logsDir` (the audit log's), `tokensPath` (the console tokens file, or null where the panel guards none) and
 *     `guarded(dir)` (is `dir` a directory `guardedFiles()` guards now);
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
  if (args.link) {
    const refuse = (why) => {
      notify([...lines, `no sign-in link was made: ${why}`].join("\n"), "warning");
      return { refused: "link", state: answer.state };
    };
    // `"tui"` exactly: a pi too old to say its mode is not known to be the operator's terminal either.
    if (deps.mode !== "tui") return refuse(`pi runs in ${deps.mode ?? "an unknown"} mode here, where a notice goes to another program, not the operator's terminal; run /dispatch console --link in pi's terminal UI, or pi-dispatch-console link in a shell`);
    if (at.refusal || at.ephemeral) return refuse("the console's address is not known here, so a link could not name it; run pi-dispatch-console link --name <name> where the console runs");
    if (answer.state !== "running") return refuse(answer.state === "not-running" ? "the console is not running, and a code expires 60 seconds after it is made" : "the console could not be confirmed running, and a code expires 60 seconds after it is made; start it, or run pi-dispatch-console link where it runs");
    // Mint only into a drop the write guard holds, so this session's own `write` could not have planted a code there.
    const codesDir = typeof deps.tokensPath === "string" && deps.tokensPath !== "" ? loginCodesDir(deps.tokensPath) : null;
    if (codesDir === null || typeof deps.guarded !== "function" || !deps.guarded(codesDir)) {
      return refuse("the panel does not see this deployment's tokens file, so it guards no login-code directory to mint into; run /dispatch setup (a deployment pointer), or start pi in the deployment folder, or use pi-dispatch-console link in a shell");
    }
    const read = (deps.readTokens ?? (() => readTokensFile({ path: deps.tokensPath })))();
    if (read.refusal) return refuse(`${read.refusal}; ${TOKEN_ADD_HINT}`);
    const operators = read.file.tokens.filter((t) => t.role === "operator").map((t) => t.name);
    let name = args.name;
    if (name !== null) {
      const entry = read.file.tokens.find((t) => t.name === name);
      if (!entry) return refuse(`there is no token named "${name}"; see pi-dispatch-console token list`);
      if (entry.role !== "operator") return refuse(`"${name}" is a ${entry.role} token, and the panel signs in operators only; use pi-dispatch-console link --name ${name} in a shell for it`);
    } else if (operators.length === 0) {
      return refuse(`the tokens file holds no operator token; ${TOKEN_ADD_HINT}`);
    } else if (operators.length === 1) {
      name = operators[0];
    } else {
      if (typeof deps.select !== "function") return refuse(`the tokens file holds ${operators.length} operator tokens; name one: /dispatch console --link <name>`);
      const picked = await deps.select("Sign in to the console as which operator token?", operators);
      if (typeof picked !== "string" || !operators.includes(picked)) {
        notify([...lines, "no sign-in link was made: no token was chosen"].join("\n"), "info");
        return { refused: "cancelled", state: answer.state };
      }
      name = picked;
    }
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
  }

  let opened = false;
  const isLocal = deps.isLocal ?? isLocalBrowserSession;
  if (url !== null && answer.state === "running") {
    if (args.noOpen) {
      // Said nothing: the operator asked for the URL alone.
    } else if (isLocal({ env: deps.sessionEnv ?? process.env, platform })) {
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
  notify(lines.join("\n"), answer.state === "not-running" ? "warning" : "info");
  return { state: answer.state, url, opened, minted };
}
