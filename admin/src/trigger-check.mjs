/**
 * A hypothetical event through the receiver's real pure filters. No token, identity lookup, queue or model
 * exists in this module. The filter may construct private job data; only its rule index and entrypoint leave here.
 */
import * as nodeFs from "node:fs";
import { FORGE_KINDS, PR_ACTIONS, REVIEW_STATES, parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { groupTriggers } from "../../receiver/src/trigger-groups.mjs";
import { filter } from "../../receiver/src/filter.mjs";
import { filterGitLab } from "../../receiver/src/filter-gitlab.mjs";
import { filterForgejo } from "../../receiver/src/filter-forgejo.mjs";
import { filterAzure } from "../../receiver/src/filter-azure.mjs";

export const CHECK_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, rules: 256, bodyBytes: 32 * 1024, comment: 4096, repository: 200, labels: 32, label: 128 });
export const CHECK_ACTORS = Object.freeze(["write", "read", "self"]);
export const CHECK_PR_AUTHORS = Object.freeze(["write", "read"]);
export const CHECK_REVIEW_BODIES = Object.freeze(["present", "empty"]);
export const CHECK_REVIEW_STATES = Object.freeze([...REVIEW_STATES]);
export const CHECK_PR_ACTIONS = Object.freeze(Object.fromEntries(Object.entries(PR_ACTIONS).map(([k, v]) => [k, Object.freeze([...v])])));
const events = ["issue-labeled", "issue-opened", "issue-comment", "pull-request", "pull-request-comment", "issue-closed"];
export const CHECK_EVENTS = Object.freeze(Object.fromEntries(FORGE_KINDS.map((f) => [f, Object.freeze(events.filter((e) => f !== "azure" || e !== "issue-closed"))])));
export const CHECK_FIELDS = Object.freeze(["forge", "event", "repository", "actor", "action", "number", "labels", "previousLabels", "comment", "prAuthor", "reviewState", "reviewBody"]);
export const CHECK_NOTICE = "Hypothetical matching only: the described identity and permissions are assumptions. No delivery was authenticated, sent or queued, and nothing was spent.";
const refusal = (code, sentence) => ({ refusal: { code, sentence } });

/** Closed and bounded before the file is opened; refusals never quote a caller's bytes. */
export function parseTriggerCheckInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return refusal("input-invalid", "Describe an event as a JSON object.");
  if (Object.keys(input).some((k) => !CHECK_FIELDS.includes(k))) return refusal("input-invalid", "The event check contains a field it does not take.");
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { return refusal("input-invalid", "The event description could not be read."); }
  if (bytes > CHECK_LIMITS.bodyBytes) return refusal("input-too-large", "The event description must fit within 32 KiB.");
  if (!Object.hasOwn(CHECK_EVENTS, input.forge)) return refusal("input-invalid", "forge must name a supported forge.");
  if (!CHECK_EVENTS[input.forge].includes(input.event)) return refusal("input-invalid", "event must name an event this forge can deliver.");
  if (!CHECK_ACTORS.includes(input.actor)) return refusal("input-invalid", "actor must explicitly say write, read or self; it is a hypothetical identity.");
  const repo = input.repository;
  const parts = typeof repo === "string" ? repo.split("/") : [];
  if (typeof repo !== "string" || repo.length > CHECK_LIMITS.repository || parts.length < 2 || (input.forge !== "gitlab" && parts.length !== 2) || parts.some((p) => !p || p.trim() !== p || p === "." || p === ".." || /[\x00-\x1f\x7f:#]/.test(p))) return refusal("input-invalid", "repository must be a forge repository path of at most 200 characters.");
  if (input.number !== undefined && (!Number.isSafeInteger(input.number) || input.number < 1 || input.number > 2_147_483_647)) return refusal("input-invalid", "number must be a positive whole item number.");
  const commentEvent = input.event.endsWith("comment");
  if (commentEvent && (typeof input.comment !== "string" || input.comment.length > CHECK_LIMITS.comment)) return refusal("input-invalid", "comment must be text of at most 4096 characters.");
  if (!commentEvent && input.comment !== undefined) return refusal("input-invalid", "comment is only used by a comment event.");
  for (const key of ["labels", "previousLabels"]) {
    const value = input[key];
    if (value !== undefined && (!Array.isArray(value) || value.length > CHECK_LIMITS.labels || value.some((v) => typeof v !== "string" || !v || v.length > CHECK_LIMITS.label || /[\x00-\x1f\x7f]/.test(v)))) return refusal("input-invalid", "labels and previousLabels take at most 32 names, each at most 128 characters.");
  }
  if (input.forge === "azure" && input.event.startsWith("pull-request") && input.labels !== undefined) return refusal("input-invalid", "Azure pull request events carry no labels or tags.");
  const hasPrevious = input.forge === "gitlab" ? ["issue-labeled", "issue-closed", "pull-request"].includes(input.event) : input.forge === "azure" && input.event === "issue-labeled";
  if (input.previousLabels !== undefined && !hasPrevious) return refusal("input-invalid", "previousLabels is only used by this forge's label-change events.");
  if (input.event === "pull-request") {
    if (!CHECK_PR_ACTIONS[input.forge].includes(input.action)) return refusal("input-invalid", "action must use this forge's pull-request vocabulary.");
  } else if (input.action !== undefined) return refusal("input-invalid", "action is only used by a pull-request event.");
  const authorRequired = input.forge === "github" && input.event === "pull-request" && ["opened", "synchronize", "reopened", "review_submitted"].includes(input.action);
  if (authorRequired && !CHECK_PR_AUTHORS.includes(input.prAuthor)) return refusal("input-invalid", "prAuthor must explicitly describe the pull request author's authority.");
  if (!authorRequired && input.prAuthor !== undefined) return refusal("input-invalid", "prAuthor is only used by a GitHub author-gated or review event.");
  const review = input.forge === "github" && input.event === "pull-request" && input.action === "review_submitted";
  if (review && !CHECK_REVIEW_STATES.includes(input.reviewState)) return refusal("input-invalid", "reviewState must name a submitted GitHub review verdict.");
  if (input.reviewBody !== undefined && (!review || !CHECK_REVIEW_BODIES.includes(input.reviewBody))) return refusal("input-invalid", "reviewBody must say present or empty on a submitted GitHub review.");
  if (!review && input.reviewState !== undefined) return refusal("input-invalid", "reviewState is only used by a submitted GitHub review.");
  return { input: { ...input, number: input.number ?? 1, labels: input.labels ?? [], ...(hasPrevious ? { previousLabels: input.previousLabels ?? [] } : {}) } };
}

/** Open/read a single bounded file, including if it grows after fstat. Errors contain no parser text or path. */
function readDocument(triggersPath, fs) {
  let fd;
  try {
    // Nonblocking open lets fstat reject a FIFO/device rather than waiting for its writer first.
    fd = fs.openSync(triggersPath, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > CHECK_LIMITS.fileBytes) return refusal("triggers-too-large", "The event checker needs a regular triggers file of at most 1 MiB.");
    const buffer = Buffer.alloc(CHECK_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > CHECK_LIMITS.fileBytes) return refusal("triggers-too-large", "The event checker needs a triggers file of at most 1 MiB.");
    const source = buffer.subarray(0, length).toString("utf8");
    const raw = JSON.parse(source);
    if (!Array.isArray(raw?.triggers) || raw.triggers.length > CHECK_LIMITS.rules) return refusal("trigger-limit", "The event checker supports at most 256 rules and requires the whole triggers list.");
    const document = parseTriggersDocument(source, "triggers file");
    return { raw: raw.triggers, groups: groupTriggers(document.triggers) };
  } catch { return refusal("triggers-unavailable", "The triggers file cannot be checked. Run pi-dispatch doctor and fix its named check."); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

/** The descriptions use fixed synthetic identities. 'write' is supplied by the person, never verified here. */
function triggerCheckFilterResult(input, groups) {
  const id = input.actor === "self" ? 1 : 2;
  const authorized = input.actor === "write";
  const labels = input.labels.map((name) => ({ name }));
  const previous = (input.previousLabels ?? []).map((name) => ({ name }));
  const target = { number: input.number, iid: input.number, labels };
  if (input.forge === "github" || input.forge === "forgejo") {
    const isPr = input.event.startsWith("pull-request");
    const isComment = input.event.endsWith("comment");
    const review = input.action === "review_submitted";
    const event = isComment ? "issue_comment" : review ? "pull_request_review" : isPr ? "pull_request" : "issues";
    const action = isComment ? "created" : review ? "submitted" : isPr ? input.action : input.event === "issue-opened" ? "opened" : input.event === "issue-closed" ? "closed" : input.forge === "forgejo" ? "label_updated" : "labeled";
    const subset = { action, sender: { id }, repository: { full_name: input.repository }, issue: { ...target, ...(isPr && isComment ? { pull_request: true } : {}) }, isPull: isPr,
      comment: { body: input.comment, author_association: authorized ? "COLLABORATOR" : "NONE" },
      pull_request: isPr && !isComment ? { ...target, author_association: input.prAuthor === "write" ? "COLLABORATOR" : "NONE", head: {}, base: {} } : undefined,
      review: review ? { state: input.reviewState, body: input.reviewBody === "empty" ? "" : "described review", author_association: authorized ? "COLLABORATOR" : "NONE" } : undefined };
    return input.forge === "github" ? filter(event, subset, { triggers: groups }, 1, "hypothetical", authorized) : filterForgejo(event, subset, groups.forgejo, groups.knownFlows, 1, authorized, "hypothetical");
  }
  if (input.forge === "gitlab") {
    const comment = input.event.endsWith("comment");
    const objectKind = comment ? "note" : input.event === "pull-request" ? "merge_request" : "issue";
    const action = comment ? "create" : input.event === "pull-request" ? input.action : input.event === "issue-opened" ? "open" : input.event === "issue-closed" ? "close" : "update";
    return filterGitLab({ objectKind, action, user: { id }, project: { id: 1, path: input.repository }, target, note: input.comment, noteableType: input.event === "pull-request-comment" ? "MergeRequest" : "Issue", ...(input.previousLabels !== undefined ? { labelChanges: { previous, current: labels } } : {}) }, groups.gitlab, groups.knownFlows, 1, authorized, "hypothetical");
  }
  const [project, repository] = input.repository.split("/");
  const pr = input.event.startsWith("pull-request");
  const eventType = input.event === "pull-request-comment" ? "ms.vss-code.git-pullrequest-comment-event" : input.event === "pull-request" ? `git.pullrequest.${input.action}` : input.event === "issue-comment" ? "workitem.commented" : input.event === "issue-opened" ? "workitem.created" : "workitem.updated";
  return filterAzure({ eventType, actor: { id: id === 1 ? "checker-self" : "checker-person" }, project: { name: project }, ...(pr ? { repository: { name: repository } } : {}), target, comment: input.comment, tags: labels, ...(input.previousLabels !== undefined ? { tagChanges: { previous, current: labels } } : {}) }, groups.azure, groups.knownFlows, { id: "checker-self" }, authorized, "hypothetical");
}

export const CHECK_REASON_SENTENCES = Object.freeze({
  "self": "The described actor is the service itself; the bot-loop guard refuses it.",
  "author-not-allowed": "The described actor does not have the authority this forge requires.",
  "pr-author-not-allowed": "The described pull request author is not an owner, member or collaborator.",
  "review-author-not-allowed": "The described reviewer is not an owner, member or collaborator.",
  "closer-not-allowed": "The described closer does not have write access.",
  "no-allowlisted-label": "The receiver's label route does not select this rule for the described labels.",
  "no-label-change": "This event added no label or tag; retaining or removing one does not fire this rule.",
  "no-trigger-phrase": "This rule provides no matching comment phrase.",
  "no-flow": "The comment resolves to no flow allowed by the armed triggers file.",
  "no-matching-pr-trigger": "The receiver's pull-request route does not select this rule for the described action and labels.",
  "review-state-not-matched": "The submitted verdict is outside this rule's reviewState narrowing.",
  "no-review-body": "A commented review with no summary starts nothing.",
  "close-number-not-matched": "This close rule names a different issue or pull request number.",
  "no-matching-close-trigger": "No armed close rule matches this event.",
  "no-repository": "The work item and rule do not name a usable repository.",
  "missing-sender-id": "The described event has no usable sender identity.",
  "missing-issue-number": "The event has no usable issue number.",
  "missing-pull-request": "The event has no usable pull request.",
  "unhandled-event": "This rule does not handle the described event.",
  "action-not-actionable": "The forge action is deliberately ignored by the receiver.",
});

function matchedOf(result) {
  const job = result.enqueue ? result.job : result.heldCandidate;
  const index = job?.trigger?.matched?.index;
  if (!Number.isSafeInteger(index)) return null;
  const route = result.heldCandidate ? "pending-parked" : job.parkedReply ? "parked-answer" : job.steerMode === "followUp" ? "follow-up-or-start" : job.steerMode === "steer" ? "steer-or-start" : "start";
  return { index, row: index + 1, route, ...(typeof job.flow === "string" ? { flow: job.flow } : {}), ...(typeof job.command === "string" ? { command: job.command.trim().split(/\s+/, 1)[0] } : {}) };
}

function onlyRule(groups, index) {
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => {
    if (!FORGE_KINDS.includes(key)) return [key, group];
    return [key, Object.fromEntries(Object.entries(group).map(([kind, rows]) => [kind, Array.isArray(rows) ? rows.filter((r) => r.index === index) : rows?.index === index ? rows : null]))];
  }));
}

/** Public result is an allowlist: no constructed job, instructions, task, input text or secret references. */
export function checkTriggerEvent({ input, triggersPath, fs = nodeFs } = {}) {
  const parsed = parseTriggerCheckInput(input);
  if (parsed.refusal) return parsed;
  const document = readDocument(triggersPath, fs);
  if (document.refusal) return document;
  const event = parsed.input;
  const decision = triggerCheckFilterResult(event, document.groups);
  const matched = matchedOf(decision);
  const rules = document.raw.map((raw, index) => {
    const base = { index, row: index + 1 };
    if (raw.on.disarmed !== undefined) return { ...base, status: "spent", reason: "spent", sentence: "This one-shot is spent and matches nothing until an operator re-arms it." };
    if (raw.on.type === "cron" || raw.on.type === "watch") return { ...base, status: "not-applicable", reason: "different-source", sentence: "This rule is started by its own schedule or watch source, not a forge event." };
    if (raw.run.kind !== event.forge) return { ...base, status: "not-applicable", reason: "different-forge", sentence: "This rule listens to a different forge." };
    if (matched?.index === index) return { ...base, status: "matched", reason: "matched", sentence: matched.route === "start" ? "This is the first matching rule for the described event, subject to the delivery's real gates." : "This rule selects a continuation route; the receiver must check the live or parked run before deciding what happens." };
    const isolated = triggerCheckFilterResult(event, onlyRule(document.groups, index));
    if (matchedOf(isolated)) return matched
      ? { ...base, status: "shadowed", reason: "earlier-match", sentence: `An earlier receiver route selected row ${matched.row}; this rule would match if that earlier rule were absent.` }
      : { ...base, status: "not-matched", reason: "context-dependent", sentence: "This rule matches in isolation, but the full receiver context selects no route; no earlier winner could be proved." };
    const reason = Object.hasOwn(CHECK_REASON_SENTENCES, isolated.reason) ? isolated.reason : "receiver-refused";
    return { ...base, status: "not-matched", reason, sentence: CHECK_REASON_SENTENCES[reason] ?? "The receiver does not select this rule for the described event." };
  });
  return { matched, rules, gates: [
    { id: "signature", state: "not-checked", sentence: "A genuine forge delivery still needs its signature or configured endpoint authentication verified." },
    { id: "authority", state: "not-checked", sentence: "The sender, service identity, reviewer, author and closer permissions here are described assumptions, not remote permission checks." },
    { id: "repository", state: "not-checked", sentence: "Repository admission and ownership still need the receiver's configured allowlist and forge checks; Azure work items select their repository from the matched rule." },
    { id: "duplicates", state: "not-checked", sentence: "Delivery and target/flow duplicate checks have not been queried or reserved." },
    { id: "runtime", state: "not-checked", sentence: "Quiet hours, the queue pause, live or parked state, job image, branch protection and spend caps are enforced when a genuine delivery arrives." },
  ], notice: CHECK_NOTICE };
}
