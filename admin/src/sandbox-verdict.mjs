/**
 * The sandbox manifest verdict both admin surfaces ask (issue #710): the `/dispatch` panel's RUN_DETAIL, through
 * `readSandboxInfo` (index.ts), and the console's run page, through the fleet reader's `sandboxCheck`.
 */
import { SANDBOX_LAUNCHERS, sandboxLauncher, sandboxSyncRefusal, sandboxVenueOf, sandboxVenuePolicy, sandboxWindowRefusal } from "@edgehero/pi-dispatch/sandbox-policy";
import { readManifest, sandboxDeadline } from "@edgehero/pi-dispatch/sandbox-store";
import { sandboxShellRefusal } from "./read-model.mjs";

/**
 * Whether run `jobId`'s workspace is still re-openable on THIS host, read from its sandbox manifest
 * (REQ-RESURRECTABLE-SANDBOX): the panel's RUN_DETAIL verdict (`readSandboxInfo`, index.ts, which adds the egress
 * posture and the runtime to it) and, since issue #710, the console run page's, so the two surfaces offer the sandbox for
 * the same runs. Moved out of index.ts for that reason: the console cannot import the extension's entry point, and a second
 * copy of these refusals is how one surface drops one. A module of its own, not the read model, which it imports
 * (`sandboxShellRefusal`); the fleet reader takes this as its `sandboxRetentionFn` seam rather than importing it back.
 * The worker predicates come from `@edgehero/pi-dispatch/sandbox-policy`, the leaf, never `/sandbox`, whose graph
 * reaches the container env builder and the model provider SDKs (review round 1: 3.1 MB of console bundle became 6.9
 * MB through this one import; admin/test/console-bundle.test.mjs holds it).
 *
 * `{ retained: false, why, reason }` or `{ retained: true, launcher, until, source, at }`. `why` is a closed word for the
 * surface's own sentence (`retention-off`, `swept`, `id-mismatch`, `policy-unreadable`, `no-image`, `workspace-gone`,
 * `unblessed`, `venue`, `no-venue`, `past-window`, `no-launcher`); `reason` is the panel pane's words, kept byte for
 * byte. `env` is the environment the venue policy is read from (the panel's own process), `now` the clock.
 *
 * `venuePolicy: "unknown"` (review round 1 of issue #710) is the console's: it never sees the PI_BACKENDS the operator's
 * shell will open the sandbox under (`OQ-038`: not a key it takes from the deployment's `.env`, and the shell that runs
 * `pi-dispatch sandbox` is not the console's), so it may not judge a venue by it. Every venue with a launcher reads as
 * blessed there, and `unblessed` and `policy-unreadable` cannot come back; what still comes back is certain whatever
 * that shell blesses (no manifest, another run's directory, no image, the workspace gone, a venue with no sandbox shell
 * at all, the window). The opener's own venue check decides the rest when the command is run.
 *
 * Synchronous on purpose: RUN_DETAIL reads it once on entry, inside a key handler, and one small `readFileSync` there is
 * cheaper than making the overlay's state a promise. Whether a sandbox is currently running is deliberately NOT asked:
 * that needs docker, and `pi-dispatch sandbox --list` already answers it.
 */
export function sandboxRetentionOf(paths, jobId, { now = Date.now, env = {}, venuePolicy = "env" } = {}) {
  if (!paths?.sandboxRetentionHours) return { retained: false, why: "retention-off", reason: "retention off" };
  const manifest = readManifest({ sandboxDir: paths.sandboxDir, jobId });
  if (!manifest) return { retained: false, why: "swept", reason: "swept" };
  // Issue #446: the same `id-mismatch` refusal `resolveSandbox` makes, so `b` is not offered for a directory that holds
  // another run (two ids that differ only in characters a file name cannot hold share one).
  if (typeof manifest.jobId === "string" && manifest.jobId !== String(jobId)) return { retained: false, why: "id-mismatch", reason: "not reopenable (another run holds its directory)" };
  // #277: the SAME venue refusal `resolveSandbox` applies when the key is pressed, asked here so the panel
  // never advertises `b` for a run this host cannot re-open. `retained` is this object's "re-openable"
  // verdict, which is what the dashboard's key guard reads.
  // THE THREE refusals `resolveSandbox` decides from the manifest alone, through the SAME predicate it
  // uses (issue #337), so the panel does not advertise `b` for a run this host cannot re-open.
  //
  // NOT every one, and the exception is named rather than left to be discovered: `decideSandboxJobUser`
  // can also refuse from the manifest alone, when the recorded job user is malformed (issue #341), and
  // that check is not in this predicate. The reason is MEASURED and lives at `sandboxSyncRefusal`'s own
  // declaration; the superseded one ("it would change what the CLI refuses and when") was corrected there
  // and left standing here for a round, which is the recurrence this round keeps catching (issue #367).
  // In short: that function checks the PLATFORM before it reads the stamp, so one malformed manifest
  // refuses on linux and every other posix and returns `{ user: null, home: null }` on darwin and win32.
  // Folding it in would make whether this panel offers `b` depend on the OPERATOR'S OS for an identical
  // run, where every other refusal here is a property of the run.
  //
  // It used to ask only the venue one, so a run whose manifest names no image, or whose local
  // folder moved, was offered the key, given two lines of egress detail about the session it would get,
  // and refused the moment the key was pressed. Copying the other two here instead of sharing them would
  // have been the shape `openSandbox`'s own docblock warns about: two callers assembling the same answer
  // from parts is how one of them drops a part.
  //
  // What stays in `openSandbox` is anything needing docker (a proxy that is not running, a sandbox
  // already up). That residual is `OQ-038`'s rather than this function's.
  //
  // The MESSAGE is the pane's own, not the refusal's: `resolveSandbox` names the workspace path, and
  // the rule here is a retention state and never a path, because a manifest path embeds an account name
  // on Windows and this view renders beside PII-free record fields.
  //
  // WHICH VENUES OPEN HERE is `env`'s `PI_BACKENDS` (issue #429), read through the worker's own parser exactly as
  // `openSandboxSession` will read it when `b` is pressed, and never the deployment's (`OQ-038`) for the panel. A panel
  // started without it sees `local` alone, so a podman run is NOT offered there rather than offered and then launched
  // under docker: the launcher is the run's own venue's, and an unblessed venue is refused before anything is asked. A
  // malformed value is its own state, as a malformed `PI_EGRESS` is: the key press would refuse, so neither is offered.
  let policy;
  try {
    policy = venuePolicy === "unknown" ? { blessed: Object.keys(SANDBOX_LAUNCHERS) } : sandboxVenuePolicy(env);
  } catch {
    return { retained: false, why: "policy-unreadable", reason: "not reopenable (PI_BACKENDS or PI_BACKEND_FLOOR unreadable here)" };
  }
  const refusal = sandboxSyncRefusal({ jobId, manifest, blessed: policy.blessed });
  if (refusal) {
    // The venue the refusal itself read: a manifest with no `backend` key is a `local` run from before attribution,
    // so in a shell whose PI_BACKENDS leaves `local` out its cause is that variable, not a missing record.
    const venue = sandboxVenueOf(manifest);
    const named = typeof venue === "string" && venue !== "";
    // A venue this build CAN open, left out of this shell's PI_BACKENDS: the one reason here an operator fixes in
    // their own shell, so it says which variable. Kept under the pane's 53 columns.
    const unblessed = named && sandboxLauncher(venue) !== null;
    if (refusal.refused === "no-image") return { retained: false, why: "no-image", reason: "not reopenable (the manifest names no image)" };
    if (refusal.refused === "workspace-gone") return { retained: false, why: "workspace-gone", reason: "not reopenable (the workspace has moved or been deleted)" };
    if (unblessed) return { retained: false, why: "unblessed", reason: `not reopenable here (PI_BACKENDS lacks ${venue})` };
    // Issue #712: the console's run page says the same words for the same venue (`sandboxShellRefusal`).
    if (named) return { retained: false, why: "venue", reason: sandboxShellRefusal(venue) ?? `not reopenable here (ran on ${venue})` };
    return { retained: false, why: "no-venue", reason: "not reopenable (no venue recorded)" };
  }
  // Issue #446: a run past its deadline, or within the opener's grace of it, is refused when `b` is pressed unless the
  // open pins it first, and the panel has no pin. So it is not offered there: the SAME predicate `resolveSandbox` asks,
  // never a copy of the window maths, and the reason names where the pin is (the CLI), kept under the pane's 53 columns.
  // The key press itself inherits the refusal from `openSandbox`, whose message carries the whole command.
  const at = now();
  if (sandboxWindowRefusal({ jobId, manifest, retentionHours: paths.sandboxRetentionHours, at })) {
    return { retained: false, why: "past-window", reason: "past its window: open it with the CLI's --pin" };
  }
  // Issue #683: a venue with no launcher row (`openshell`) is refused by `sandboxSyncRefusal` above; if one ever reached
  // here, it is not reopenable, never reopened under docker.
  const launcher = sandboxLauncher(sandboxVenueOf(manifest));
  if (!launcher) return { retained: false, why: "no-launcher", reason: sandboxShellRefusal(sandboxVenueOf(manifest)) ?? "not reopenable (its venue has no sandbox shell)" };
  // The sweep's own deadline rule (issue #446): the pin, else the earlier of the `retainUntil` the worker wrote and
  // `createdAt` plus the window.
  const { until, source } = sandboxDeadline(manifest, paths.sandboxRetentionHours);
  return { retained: true, launcher, until, source, at };
}
