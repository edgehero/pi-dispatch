/**
 * The fleet run mirror's word, and the one rule for every reader of it (issue #988).
 *
 * A read of the mirror says how it went in one word (`readMirroredRuns`' `degraded`, which `mergedRunsOn` and the page
 * readers hand on as `mirror` or `runMirror`):
 *
 *   "ok"                 the mirror answered, and what it holds was read          -> read
 *   "truncated"          it answered, and holds more than the read's bound        -> cut
 *   "off"                there is no mirror: a single host, or a fleet below the
 *                        version floor, whose history this host's files are       -> off
 *   "unreachable (why)"  it did not answer                                        -> unread
 *
 * An agent's copy of the data (`agentReadProjection`) carries four words: "off", "unreachable", "truncated", and
 * "bounded" for a mirror that answered and was read whole ("ok"), so "bounded" is read here. It carried three, with
 * "truncated" folded into "bounded", until issue #1073. Any other word is one this build does not know, and is taken as
 * unread: a reader that cannot tell must not say the history was read.
 *
 * Each reader had its own test of the word (`!== "ok"`, `startsWith("unreachable")`, a list of two, a list of three),
 * so an operator and an agent could be told different things of the same mirror, and "truncated" was unread to one
 * reader and read to another.
 */
export function mirrorStateOf(word) {
  if (typeof word !== "string") return null;
  if (word === "ok" || word === "bounded") return "read";
  if (word === "truncated") return "cut";
  if (word === "off") return "off";
  return "unread";
}

/** The mirror is on and did not answer: what it holds of the other hosts' runs was not read. */
export const mirrorUnread = (word) => mirrorStateOf(word) === "unread";

/** The mirror is on and answered, whole or cut at the read's bound: other hosts' runs were read through it. */
export const mirrorAnswered = (word) => mirrorStateOf(word) === "read" || mirrorStateOf(word) === "cut";
