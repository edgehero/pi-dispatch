/** Names-only Secrets page facts (#751). Nothing here invokes a resolver or carries its path into the result. */
import * as nodeFs from "node:fs";
import { delimitedList } from "@edgehero/pi-dispatch/config";
import { projectOf } from "@edgehero/pi-dispatch/projects";
import { envSecretProfiles, envBundleProfiles, overlayBundleProfiles, resolverRootsStatus, secretProfilesView, secretBundlesView } from "./read-model.mjs";

const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const named = (v) => typeof v === "string" && NAME.test(v);
const indices = (xs) => (Array.isArray(xs) ? xs : []).filter((x) => Number.isSafeInteger(x) && x >= 0);
const safeLast = (last, bundle = false) => last ? { jobId: typeof last.jobId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(last.jobId) ? last.jobId : null, at: typeof last.at === "string" && Number.isFinite(Date.parse(last.at)) ? last.at : null, ...(bundle ? { variables: (last.variables ?? []).filter((n) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) } : { outcome: ["refused", "resolved", "not-reached"].includes(last.outcome) ? last.outcome : "not-reached", reason: typeof last.reason === "string" && /^[a-z0-9-]{1,64}$/.test(last.reason) ? last.reason : null, bundled: last.bundled === true }) } : null;

/**
 * Why a source of the secret lists gave no rows (issue #962), in the two words the configuration pages use for the two
 * cases: "could not be read" for a file that is there and unreadable (or no view of it at all), "does not load" for one
 * that was read and is refused. Null for a source that was read, and for a triggers or projects file that is not there
 * or not configured: it names and binds nothing, so its zero is a read's own answer. The settings reader folds an
 * unreadable file into `invalid`, and its message says which.
 */
export function fileUnreadWord(kind, view) {
  const READ = "could not be read", LOAD = "does not load";
  if (view === null || typeof view !== "object") return READ;
  if (kind === "settings") return !view.invalid ? null : /^settings file unreadable/.test(String(view.invalid)) ? READ : LOAD;
  const rows = kind === "triggers" ? view.triggers : view.projects;
  if (Array.isArray(rows) || view.missing === true || view.unset === true) return null;
  return view.invalid ? LOAD : READ;
}
const SOURCE_NAMES = Object.freeze({ settings: "the settings overlay", triggers: "the triggers file", projects: "the projects file" });
/**
 * What stands between a page and a whole count of the profiles (the overlay and the triggers file name them) and of the
 * bundles (the triggers file binds them), as one phrase ("the triggers file does not load"), or null where every
 * source was read. The one rule of Secrets and of Configuration's two secret cards, from the snapshot's own views.
 */
export function secretCountTrouble(held) {
  const said = (kinds) => kinds.map((kind) => [kind, fileUnreadWord(kind, held?.[kind])]).filter(([, word]) => word !== null).map(([kind, word]) => `${SOURCE_NAMES[kind]} ${word}`).join(" and ") || null;
  return { profiles: said(["settings", "triggers"]), bundles: said(["triggers"]) };
}

/** The cheap scheduler observation, with conflicting queue reports kept unknown. No future fire is invented. */
function nextOf(t, snapshot) {
  if (t.type !== "cron") return null;
  const rows = (snapshot?.schedulers ?? []).filter((s) => s.key === t.id);
  const values = [...new Set(rows.map((s) => Number.isSafeInteger(s.next) && s.next >= 0 ? s.next : null))];
  return { index: t.index, id: named(t.id) ? t.id : null, at: rows.some((s) => s.pattern !== t.pattern) || values.length !== 1 ? null : values[0] };
}

/**
 * Page-only assembly. `snapshot` is the common reader's internal snapshot; `env` stays on the server. `fs` is used
 * only for the same local realpath judgement as the existing profile view, never to read a resolver's contents.
 *
 * `files` is the reader's `fileViews` where the snapshot failed (issue #962): the declarations live in the settings
 * overlay, the triggers file, the projects file and the `.env`, none of which needs Valkey, so they are drawn from
 * there. `filesKnown` says the declarations were read from either; `fleetKnown` says the snapshot was, and where it
 * was not, what a run last received and which hosts serve a profile are not known, never "no run" or "no host".
 * `triggersKnown` is true of a triggers file that was read and of one that is not there, which binds nothing and names
 * no profile: only a file that is there and could not be read leaves its bindings unknown. `projectsKnown` is the same
 * of the projects file, one that is not configured included. `unread` holds each source's word (`fileUnreadWord`) and
 * `countTrouble` the phrase a count says in place of a number.
 */
export function secretsView({ snapshot = null, files = null, env = {}, fs = nodeFs } = {}) {
  const held = snapshot ?? (files !== null && typeof files === "object" ? files : null);
  const fromEnv = envSecretProfiles(env.PI_SECRET_PROFILES);
  const bundleEnv = envBundleProfiles(env.PI_SECRET_BUNDLES);
  const roots = delimitedList(env.PI_SECRET_RESOLVER_ROOTS);
  const settings = held?.settings ?? null;
  const triggers = held?.triggers ?? null;
  const projects = held?.projects ?? null;
  const overlayProfiles = settings?.overlay?.secretProfiles ?? {};
  const overlayBundles = overlayBundleProfiles(settings);
  // With no snapshot the registry was not read: said as unreadable, so no row reads "no live host advertises it".
  // Read in part (issue #1062): the rows it read, said as read in part, a host whose row did not answer left out.
  const fleetPart = snapshot !== null && Boolean(snapshot?.queue?.fleetDegraded) && snapshot?.queue?.registryReadInPart === true;
  const fleetUnreadable = !fleetPart && (snapshot === null || Boolean(snapshot?.queue?.fleetDegraded || snapshot?.fleetDegraded));
  const readRows = (rows) => (Array.isArray(rows) ? rows.filter((h) => h?.notRead !== true) : rows);
  const profileFacts = snapshot?.secretProfiles ?? secretProfilesView({ triggers, settings, env, projects, runs: snapshot?.runs, hosts: fleetUnreadable ? null : readRows(snapshot?.hostBudgets ?? snapshot?.hosts), hostsUnreadable: fleetUnreadable, hostsReadInPart: fleetPart, fs });
  const bundleFacts = snapshot?.secretBundles ?? secretBundlesView({ triggers, settings, env, projects, runs: snapshot?.runs, fs });
  const profileCollisions = Object.keys(overlayProfiles).filter((n) => Object.hasOwn(fromEnv.profiles, n)).sort();
  const bundleCollisions = Object.keys(overlayBundles).filter((n) => Object.hasOwn(bundleEnv.profiles, n)).sort();
  const rootsSeen = typeof env.PI_SECRET_RESOLVER_ROOTS === "string";
  const rootsState = (path) => { try { return resolverRootsStatus(path, env, fs).status; } catch { return "unresolved"; } };
  const rows = (profileFacts?.profiles ?? []).filter((p) => named(p.name)).map((p) => {
    const refused = fromEnv.malformed || profileCollisions.length > 0 || ["outside", "empty"].includes(p.roots) || (p.source === "undeclared" && profileFacts.envSeen === true);
    const ownTriggers = (triggers?.triggers ?? []).filter((t) => indices(p.triggers).includes(t.index));
    return { name: p.name, source: ["env", "overlay", "ambiguous", "undeclared"].includes(p.source) ? p.source : "unknown", roots: ["inside", "outside", "empty", "unseen", "unresolved"].includes(p.roots) ? p.roots : null, triggers: indices(p.triggers), triggersMore: p.triggersMore ?? 0, projects: (p.projects ?? []).filter(named), projectsMore: p.projectsMore ?? 0, anyRepo: p.anyRepo === true, uses: ownTriggers.map((t) => ({ trigger: t.index, variables: Number.isSafeInteger(t.secrets) && t.secrets >= 0 ? t.secrets : null, project: t.type === "cron" && Array.isArray(projects?.projects) && typeof t.folder === "string" ? projectOf({ kind: "local", folder: t.folder }, projects.projects) : null, anyRepo: t.type !== "cron" })), last: safeLast(p.last), hosts: (p.hosts ?? []).filter(named), hostsUnknown: p.hostsUnknown ?? 0, refused, inOverlay: Object.hasOwn(overlayProfiles, p.name), cron: ownTriggers.map((t) => nextOf(t, snapshot)).filter(Boolean) };
  });
  const resolvers = [...new Set([...Object.keys(bundleEnv.profiles), ...Object.keys(overlayBundles)])].filter(named).sort().map((name) => {
    const own = Object.hasOwn(overlayBundles, name);
    const source = own && Object.hasOwn(bundleEnv.profiles, name) ? "ambiguous" : own ? "overlay" : "env";
    const root = own ? rootsState(overlayBundles[name].path) : null;
    return { name, source, format: source === "env" ? bundleEnv.profiles[name].format : overlayBundles[name]?.format ?? null, roots: root, inOverlay: own, refused: bundleEnv.malformed || bundleCollisions.length > 0 || ["outside", "empty"].includes(root) };
  });
  const bindings = (bundleFacts?.bundles ?? []).filter((b) => named(b.id)).map((b) => {
    const resolver = resolvers.find((r) => r.name === b.profile);
    const declared = bundleEnv.malformed ? "env-malformed" : bundleCollisions.length > 0 ? "ambiguous" : resolver?.source === "env" ? "env" : resolver?.roots === "outside" || resolver?.roots === "empty" ? "overlay-outside-roots" : resolver ? "overlay" : typeof env.PI_SECRET_BUNDLES === "string" ? "missing" : "unseen";
    return { id: b.id, project: named(b.project) ? b.project : null, profile: named(b.profile) ? b.profile : null, format: resolver?.format ?? b.format ?? null, declared, roots: resolver?.roots ?? null, rootsSeen, projectKnown: b.projectKnown, forkReviews: b.forkReviews === true, endpoints: (b.endpoints ?? []).filter((e) => typeof e.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)).map((e) => ({ name: e.name, host: typeof e.host === "string" && /^[A-Za-z0-9.:[\]-]+$/.test(e.host) ? e.host : null })), optedOut: indices(b.optedOut), last: safeLast(b.last, true), refused: ["env-malformed", "ambiguous", "overlay-outside-roots", "missing"].includes(declared) };
  });
  const problems = [];
  const add = (rank, key, title, sentence, fix, action = null) => problems.push({ rank, key, title, sentence, fix, action });
  for (const [kind, malformed] of [["PI_SECRET_PROFILES", fromEnv.malformed], ["PI_SECRET_BUNDLES", bundleEnv.malformed]]) if (malformed) add(0, `malformed-${kind}`, `${kind} does not parse`, "The worker does not start while this declaration does not parse.", `Correct ${kind} in the deployment's .env and restart the worker.`);
  for (const [kind, collisions] of [["profile", profileCollisions], ["bundle", bundleCollisions]]) for (const name of collisions) add(1, `ambiguous-${kind}-${name}`, `Refused: ${name} is declared twice`, `It is in ${kind === "profile" ? "PI_SECRET_PROFILES" : "PI_SECRET_BUNDLES"} and the settings overlay, so the worker refuses every ${kind === "profile" ? "secrets" : "bundled"} job until no name is declared in both.`, "Remove it from one source.", { action: `secret-${kind}-remove`, name });
  if (rootsSeen && roots.length === 0) add(2, "empty-roots", "The resolver roots are set and empty", "The worker refuses every resolver the settings overlay declares.", "Set PI_SECRET_RESOLVER_ROOTS to the directories that hold the resolvers.");
  for (const p of rows) if (p.source === "undeclared" && profileFacts?.envSeen === true) add(3, `missing-profile-${p.name}`, `Refused: profile ${p.name} is not declared`, "Its triggers cannot resolve their secrets before a container starts.", "Declare its resolver in the .env or settings overlay."); else if (p.roots === "outside") add(3, `outside-profile-${p.name}`, `Refused: ${p.name} is outside the resolver roots`, "The worker refuses every job naming this resolver.", "Put its resolver inside PI_SECRET_RESOLVER_ROOTS or correct the roots.");
  for (const r of resolvers) if (r.roots === "outside") add(3, `outside-bundle-${r.name}`, `Refused: bundle resolver ${r.name} is outside the roots`, "The worker refuses this resolver's bundled jobs.", "Put its resolver inside PI_SECRET_RESOLVER_ROOTS or correct the roots.");
  for (const b of bindings) if (b.declared === "missing") add(3, `missing-bundle-${b.id}`, `Refused: bundle ${b.id} has no declared resolver`, "Its project's bundled jobs are refused before they spend.", `Declare bundle resolver ${b.profile}.`);
  if (profileFacts?.hostsUnreadable !== true && profileFacts?.hostsReadInPart !== true && Number.isInteger(profileFacts?.hostsSeen)) for (const p of rows) if (!p.refused && p.triggers.length > 0 && p.hosts.length === 0 && p.hostsUnknown === 0) add(4, `unserved-${p.name}`, `No live host advertises ${p.name}`, "No live host in the registry advertises this profile.", "Check the worker's resolver declaration and its published capabilities.");
  problems.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  const unread = { settings: fileUnreadWord("settings", settings), triggers: fileUnreadWord("triggers", triggers), projects: fileUnreadWord("projects", projects) };
  return { filesKnown: held !== null, fleetKnown: snapshot !== null, settingsKnown: unread.settings === null, triggersKnown: unread.triggers === null, projectsKnown: unread.projects === null, unread, countTrouble: secretCountTrouble(held), projectIds: (projects?.projects ?? []).map((p) => p.id).filter(named), roots: { seen: rootsSeen, count: roots.length, empty: rootsSeen && roots.length === 0 }, profileEnvMalformed: fromEnv.malformed, bundleEnvMalformed: bundleEnv.malformed, profiles: rows, bundleResolvers: resolvers, bundles: bindings, problems, profileState: { envSeen: profileFacts?.envSeen ?? fromEnv.seen, hostsSeen: profileFacts?.hostsSeen ?? null, hostsUnreadable: profileFacts?.hostsUnreadable === true, ...(profileFacts?.hostsReadInPart === true ? { hostsReadInPart: true } : {}) }, profileCollisions, bundleCollisions };
}

/**
 * Model reads may reason about names and counts, never the manager's variable names or host paths. `available` is what
 * it was: the snapshot was read. A view drawn from the files alone holds no run and no host fact, and this read's
 * `variables` and `problems` would then state what was not read.
 */
export function modelSecrets(view) {
  const profiles = (view?.profiles ?? []).map(({ name, source, roots, triggers, projects, anyRepo, uses, refused }) => ({ name, source, roots, triggers, projects, anyRepo, uses: uses ?? [], refused }));
  const ids = [...new Set([...(view?.projectIds ?? []), ...(view?.bundles ?? []).map((b) => b.project).filter(Boolean)])];
  return { available: view?.fleetKnown === true, problems: (view?.problems ?? []).map(({ key, title }) => ({ key, title })), profiles, bundleResolvers: (view?.bundleResolvers ?? []).map(({ name, source, format, refused }) => ({ name, source, format, refused })), projects: ids.map((project) => {
    const b = view?.bundles?.find((row) => row.project === project);
    return { project, bundle: b?.id ?? null, profile: b?.profile ?? null, declared: b?.declared ?? null, variables: b?.last?.variables?.length ?? null, forkReviews: b?.forkReviews === true, optedOut: b?.optedOut ?? [], profiles: profiles.flatMap((p) => p.uses.filter((u) => u.project === project || u.anyRepo).map((u) => ({ profile: p.name, trigger: u.trigger, variables: u.variables, anyRepo: u.anyRepo }))) };
  }) };
}
