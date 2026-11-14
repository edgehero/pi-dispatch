/**
 * A run's short link (issue #882, part 3): `/run/<repository path>/<number>`, with `!` before the number for a merge
 * request (`/run/<repository path>/!<number>`). It names an issue, a pull request or a merge request, never one run,
 * and opens the newest run on it (`server.mjs` `getRunPath`, through `run-api.mjs` `resolveRunPath`), so a person can
 * read it out or type it where the run's id (`gh-<delivery GUID>`) is hard to say. The run page shows it beside the id
 * (`runPathLink`); on an older run's page it leads to the later one, which its title says.
 *
 * WHY A PATH, NOT A QUERY. `/run?id=` keeps its query, unchanged, for the id. A short link is read back by a person,
 * and `?target=acme%2Fweb%2312` is not readable: `#` ends a URL's path, so the number is a segment of its own and the
 * issue's `#` is left out, as the forge's own URL leaves it out (`/issues/12`).
 *
 * WHY `!` FOR A MERGE REQUEST. GitLab and Azure number merge (pull) requests apart from issues, so `group/proj#5` and
 * `group/proj!5` are two things (`worker/src/forges.mjs`, `pullRequestSep`), and the link must say which. `!` is the
 * forge's own sigil and the one the run's target is written with, so the link reads back as the target does. It is
 * URL-safe: a sub-delimiter RFC 3986 allows in a path segment, which no browser, `new URL` or proxy percent-encodes.
 * And it cannot be read as part of the repository: no forge's repository charset holds it. REJECTED: a word segment
 * (`/mr/5`), which a GitLab subgroup named `mr` makes ambiguous (`/run/group/mr/5`), and `~` or `-`, which say nothing a
 * person knows. One cost, said in the docs: an interactive shell expands `!5` as history, so a terminal quotes it.
 *
 * NO FORGE IN THE LINK. A run's target names no forge (`acme/web#12` is GitHub's or Forgejo's), so the link does not
 * either, and every forge's runs are looked in. A deployment whose two forges both hold runs on one path is answered
 * with the runs search for it (`resolveRunPath`'s `several`), never a guess.
 *
 * THE SHAPE, held here for the route and the run page alike, so a link the page draws is a link the route reads back
 * to the same target (`targetKeyOf`; a test holds the round trip): at least two repository segments and at most
 * `RUN_PATH_SEGMENTS_MAX` (a GitLab project under 20 subgroups, `read-model.mjs` `FORGE_REPO_RE.gitlab`), each of
 * letters, digits, `.`, `_`, `-` and inner spaces (an Azure project's name may hold one; it travels as `%20`), never
 * `.` or `..`; then the number, its leading zeros dropped as the forges and `targetKeyOf` drop them. Each segment is
 * percent-decoded once, and one that does not decode, or decodes to a `/`, is refused, as `forgeTargetOf` refuses it.
 */
import { FORGES, isForgeKind } from "@edgehero/pi-dispatch/forges";
import { html } from "./html.mjs";

/** Where every short link starts. `/run` alone, with its `?id=`, is the run page and is not one. */
export const RUN_PATH_PREFIX = "/run/";

/** The most repository segments a short link takes: a GitLab project under 20 subgroups. */
export const RUN_PATH_SEGMENTS_MAX = 21;

/** The longest target a short link names: the run target's own bound (`run-api.mjs` `TARGET_RE`). */
const TARGET_MAX = 300;

/** One repository segment, decoded: letters, digits, `.`, `_`, `-`, and a space inside, at most 100 characters. */
const SEGMENT_RE = /^[A-Za-z0-9._-](?:[A-Za-z0-9._ -]{0,98}[A-Za-z0-9._-])?$/;

/** The last segment: the number, with `!` before it for a merge request. */
const NUMBER_RE = /^(!?)(\d{1,30})$/;

/** A run target as the worker writes a forge's: the repository, `#` or `!`, and the number. */
const TARGET_PARTS_RE = /^(.+)([#!])(\d{1,30})$/;

/** What a short link that cannot be read is told: the shape, never the value (`parsePageQuery`'s rule). */
export const RUN_PATH_REFUSAL = "a short run link is /run/<repository>/<number>, with ! before the number for a merge request";

/** A short link that carries a query is refused with this: the link is the whole question. */
export const RUN_PATH_QUERY_REFUSAL = "a short run link takes no query parameters";

const okSegment = (s) => SEGMENT_RE.test(s) && s !== "." && s !== "..";

/**
 * The issue or request a short link names: `{ target, repo, sep, number }` (`target` the run target's own spelling,
 * `acme/web#12` or `group/proj!7`, the number without leading zeros), or `{ refusal }` (`RUN_PATH_REFUSAL`) for a
 * pathname that is not one. `pathname` is the request's, as `new URL` parsed it (percent-encoded, dot segments already
 * resolved); a trailing `/` is allowed.
 */
export function parseRunPath(pathname) {
  const refused = { refusal: RUN_PATH_REFUSAL };
  if (typeof pathname !== "string" || !pathname.startsWith(RUN_PATH_PREFIX) || pathname.length > 4 * TARGET_MAX) return refused;
  const raw = pathname.slice(RUN_PATH_PREFIX.length).replace(/\/$/, "").split("/");
  let segments;
  try {
    segments = raw.map((seg) => decodeURIComponent(seg));
  } catch {
    return refused; // a malformed percent escape
  }
  if (segments.length < 3 || segments.length > RUN_PATH_SEGMENTS_MAX + 1) return refused;
  const m = NUMBER_RE.exec(segments.at(-1));
  const repoSegments = segments.slice(0, -1);
  if (m === null || !repoSegments.every(okSegment)) return refused;
  const repo = repoSegments.join("/");
  const sep = m[1] === "!" ? "!" : "#";
  const number = m[2].replace(/^0+(?=\d)/, "");
  const target = `${repo}${sep}${number}`;
  if (target.length > TARGET_MAX) return refused;
  return { target, repo, sep, number };
}

/**
 * The short link of a run of `kind` on `target` (a record's, or a running job's facts), or null: none for a run that is
 * not a forge's (a local, scheduled or watch run names no issue), a target that is not `<repository><#|!><number>`, a
 * `!` on a forge that never writes one, or a repository the link cannot carry (`parseRunPath`'s shape). Each segment
 * is percent-encoded (a space as `%20`; `!` stays as it is), and the number loses its leading zeros.
 */
export function runPathOf(kind, target) {
  if (!isForgeKind(kind) || typeof target !== "string" || target.length > TARGET_MAX) return null;
  const m = TARGET_PARTS_RE.exec(target);
  if (m === null) return null;
  const [, repo, sep, digits] = m;
  if (sep === "!" && FORGES[kind].pullRequestSep !== "!") return null;
  const segments = repo.split("/");
  if (segments.length < 2 || segments.length > RUN_PATH_SEGMENTS_MAX || !segments.every(okSegment)) return null;
  return `${RUN_PATH_PREFIX}${segments.map((s) => encodeURIComponent(s)).join("/")}/${sep === "!" ? "!" : ""}${digits.replace(/^0+(?=\d)/, "")}`;
}

/** What the short link's title says it opens: the newest run on the issue or request, which may be a later one. */
export function runPathTitle(target) {
  return `Opens the newest run on ${target}`;
}

/**
 * The short link beside a run page's id (the RunEnded and RunLive cards' title line), or null when the run has none
 * (`runPathOf`). `run` is the run record, or a running job's facts (`runLiveFacts`): `kind` and `target` are read.
 * A link and nothing more: the page offers Copy only in its command boxes (the clipboard needs a secure context, which
 * the script tells), and a link is copied as any link is.
 */
export function runPathLink(run) {
  const path = runPathOf(run?.kind, run?.target);
  if (path === null) return null;
  return html`<a class="run-path" href="${path}" title="${runPathTitle(run.target)}">${path}</a>`;
}
