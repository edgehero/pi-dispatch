# Interfaces

The contracts below cross a process or container boundary. These are the seams where a mistake is
expensive, because both sides ship separately and nothing type-checks across the gap.

Note what makes this file worth having at a project this size: **these cross a trust boundary, not just
a process boundary.** The container is the untrusted side. Two of these contracts are the *mechanism* by
which a constitutional constraint is enforceable rather than aspirational, and one of them fails
completely silently.

There is deliberately **no data-design document**: there is no database. Redis holds BullMQ's schema,
which is BullMQ's to specify, not ours.

Evidence convention as in `constitution.md`.

---

## INT-SDK-SESSION-OPTIONS

**runner → pi SDK.** The most valuable block in this file — the only contract here that fails
*invisibly*.

- **Contract**:
  **Verified against the published `0.80.7` tarball, not against HEAD** — see the evidence convention
  in `constitution.md`. At this pin the model/auth wiring is `AuthStorage` + `ModelRegistry`. There is
  **no `ModelRuntime`**: that is HEAD-only, `[Unreleased]`, and importing it makes every job die on a
  missing export while the image builds cleanly.

  ```typescript
  const authStorage   = AuthStorage.create(`${agentDir}/auth.json`);
  // Prefer the operator overlay's models.json when the :ro overlay is mounted (REQ-GLOBAL-PI-OVERLAY) —
  // how a CUSTOM provider/model becomes resolvable. Definitions only; the key still flows env -> auth.json.
  const modelsPath = existsSync("/opt/pi-global/models.json") ? "/opt/pi-global/models.json" : `${agentDir}/models.json`;
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const model = modelRegistry.find(process.env.PI_PROVIDER, process.env.PI_MODEL);  // NOT getModel
  if (!model) throw configError(`unknown model`);   // configError tags exit 2 — see below
  if (!modelRegistry.hasConfiguredAuth(model)) throw configError(`no configured auth`);

  // Guardrails read EXPLICITLY from a path we own — never via discovery. See (e).
  const guardrails     = readFileSync("/opt/pi-dispatch/HARD_RULES.md", "utf8");
  const globalPersona  = readIfExists("/opt/pi-global/APPEND_SYSTEM.md"); // operator overlay, :ro (REQ-GLOBAL-PI-OVERLAY)
  const projectPersona = readIfExists("/job/pi/APPEND_SYSTEM.md");        // :ro, default-branch SHA

  const resourceLoader = new DefaultResourceLoader({
    cwd: "/workspace",
    agentDir: getAgentDir(),
    settingsManager,                                   // the SAME inMemory manager passed to the session
    // Context files and extensions are DISCOVERED, as in any pi run: /workspace is the base repo's
    // DEFAULT-BRANCH sha, so its files are merge-gated. CONST-NO-CONTEXT-FILES-MANDATORY was AMENDED
    // to this posture — read the two together, not as a disagreement. See (c).
    noContextFiles: false,                             // the repo's AGENTS.md loads
    noExtensions: false,                               // /workspace/.pi/extensions is discovered — see (f), (j)
    // Skills are the EXCEPTION, and it is mechanical, not a trust judgement: the repo's skills already
    // arrive at /job/pi/skills from the pinned sha, and discovery would re-register them under a second
    // path that WINS the first-path-wins collision. See (k).
    noSkills: true,
    // Repo FIRST, then the trigger's injected skills, then the overlay: repo > injected > overlay
    // (REQ-PER-TRIGGER-SKILLS). pi is first-path-wins and the order within this array is ours.
    additionalSkillPaths:     ["/job/pi/skills",
                               ...(existsSync("/job/trigger-skills") ? ["/job/trigger-skills"] : []),
                               ...(existsSync("/opt/pi-global/skills") ? ["/opt/pi-global/skills"] : [])],
    // Overlay extensions load unless the operator opted OUT (PI_GLOBAL_ALLOW_EXTENSIONS=0) AND the dir
    // is present. Operator-staged pi packages (REQ-GLOBAL-PI-OVERLAY) come LAST and do NOT ride that
    // option — the spread is unconditional, because the worker already applied the per-trigger
    // `run.packages` opt-out before emitting PI_PACKAGES. Two switches, withholding two different things:
    // withholding ALL third-party extension code takes both. LAST is the trust ordering: extension
    // resolution is first-path-wins, so nothing a package ships can shadow a repo or overlay
    // EXTENSION. That ordering fix does NOT extend to skills; skillsOverride below is where that is
    // settled. With noExtensions off, reload() merges the paths DISCOVERED under /workspace/.pi/
    // extensions AFTER this whole list, so a workspace extension is last of all and shadows nothing.
    additionalExtensionPaths: ["/job/pi/extensions", ...(allowGlobalExtensions && existsSync("/opt/pi-global/extensions") ? ["/opt/pi-global/extensions"] : []), ...packagePaths],
    // The recursion guard (REQ-ADMIN-VIA-PI-EXTENSION Scope), and the reason discovery is affordable at
    // all: a serviced repo may ship an admin extension (THIS repo does, at .pi/extensions/dispatch.ts),
    // which would hand a job's model dispatch_run — a PAID enqueue from inside a paid job. Applied to
    // the loaded set BEFORE the loader stores it, so a dropped extension registers no tool and receives
    // no event. FILTER, not refuse: refusing would end self-hosting. See (j).
    extensionsOverride: (loaded) => dropAdminExtensions(loaded, { roots: extensionRoots, log }),
    // REQ-GLOBAL-PI-OVERLAY's "repo wins on conflict", ENFORCED. pi builds skillPaths as
    // mergePaths(cliEnabledSkills, additionalSkillPaths), so a staged package's skill paths come FIRST
    // whatever we do, and loadSkills is first-path-wins — path order cannot carry this. This declared
    // loader option runs on loadSkills' result before anything is stored, so precedence is re-imposed
    // there: a kept skill under a package root whose name also exists under /job/pi/skills or
    // /opt/pi-global/skills is replaced by the protected one (repo consulted before overlay), the
    // substitute coming from pi's own public loadSkillsFromDir({dir, source:"path"}). See (i).
    skillsOverride: (loaded) => enforceProtectedSkillPrecedence(loaded, { packageRoots: packagePaths, protectedRoots: ["/job/pi/skills", "/opt/pi-global/skills"] }),
    // The overlay's prompt TEMPLATES (issue #189, OQ-019 (b)): skills and extensions already had a
    // channel, templates had none. Merged AFTER discovery, so the repo's .pi/prompts still wins
    // first-path-wins against the overlay.
    additionalPromptTemplatePaths: [...(existsSync("/opt/pi-global/prompts") ? ["/opt/pi-global/prompts"] : [])],
    // "Repo wins on conflict" for prompt templates — the same inversion skillsOverride closes for
    // skills (pi merges package prompt paths FIRST and dedupePrompts is first-wins). The substitute
    // cannot come from a per-dir pi loader (none is exported at the pin; the exports map is closed),
    // so the protected set is PRE-LOADED by a second, minimal DefaultResourceLoader over the repo's
    // .pi/prompts then the overlay's prompts/ — pi's own reader through its public surface, never a
    // hand-rolled parser — built only when packages are staged, so the common job pays nothing. This
    // is also the second half of the run.command fall-through closure: getCommand() forecloses an
    // UNREGISTERED /name reaching a template, and this forecloses a package template shadowing a
    // protected one (DES-COMMAND-ENTRY-POINT).
    promptsOverride: (loaded) => enforceProtectedPromptPrecedence(loaded, { packageRoots: packagePaths, protectedPrompts }),
    // Floor first (unremovable), then the outbox protocol (local jobs only — the /outbox mount is what
    // makes it relevant), then operator-global, then repo (most specific). Deploy-time overlay persona
    // is the SAME trust class as baking (DES-OPERATOR-GLOBAL-OVERLAY), distinct from the admin-editable
    // runtime settings overlay, which still may never carry persona. This override is ALSO what keeps
    // the floor safe now that the project is discovered: it discards the discovered value entirely, so
    // a project APPEND_SYSTEM.md cannot shadow the guardrails. See (e).
    appendSystemPromptOverride: () => [guardrails, outboxProtocol, globalPersona, projectPersona].filter(Boolean),
  });
  await resourceLoader.reload();        // MANDATORY — createAgentSession will NOT do this for you
  // NOTE: reload() is NOT called with `resolveProjectTrust` — we never CALL it. That is not the same as
  // the project being untrusted: the in-memory settings default to TRUSTED, and that default is what
  // makes repo-extension discovery fire at all. See (f).

  // HOISTED: the ROOT session id must exist BEFORE the meter does. createAgentSession would otherwise
  // build its own SessionManager and the id would be readable only afterwards — too late to split
  // rootTotal from otherTotal, and an undefined root files every call as unattributed.
  // CONDITIONAL since issue #48: in-memory when PI_SESSION_FILE is unset (the default, and every job
  // before that change), a persisted manager when it is set (REQ-RESUMABLE-SESSION). See (l).
  const { sessionManager } = openSessionManager({ sessionFile, cwd: "/workspace" });
  const rootSessionId  = sessionManager.getSessionId();

  // Declared BEFORE the meter so onBreach can close over it; assigned the moment the session exists.
  let session;

  // Process-wide usage meter (REQ-TOKEN-ACCOUNTING-AND-CAPS). AFTER ModelRegistry.create — it registers
  // THROUGH the registry so refresh() re-applies it — and BEFORE createAgentSession, so the first call
  // of the run is already metered. See (g) and (h).
  const meter      = createUsageMeter({ maxTokens, rootSessionId, onBreach: () => { void session?.abort(); } });
  const usageMeter = await installProcessUsageMeter({ modelRegistry, meter });

  ({ session } = await createAgentSession({
    cwd: "/workspace",
    agentDir: getAgentDir(),
    authStorage,
    modelRegistry,
    model,
    sessionManager,
    settingsManager: SettingsManager.inMemory({ retry: { maxRetries, baseDelayMs } }),
    resourceLoader,
  }));

  usageMeter.arm();   // extensions register their OWN api providers during createAgentSession — an api id
                      // that did not exist at install time is unwrapped until this deterministic re-arm.
  // The per-session accumulator is the FALLBACK, attached ONLY when the meter could not install, so the
  // two are never both counting: attachTokenBudget(session, maxTokens) if (!usageMeter.ok).
  ```
  **The project's persona and skills use pi's native structure — `.pi/APPEND_SYSTEM.md` and
  `.pi/skills/**/SKILL.md` (the Agent Skills spec) — and are loaded through the explicit
  `additional*Paths` channel from a read-only mount, not through pi's cwd discovery.** Inventing a
  bespoke `.pi-dispatch/` layout would reimplement pi's resource system (`no-reimplementing-pi`). The
  materialised route survives the discovery relaxation on its own merits, which are no longer about
  trust: `/job/pi` is read from the pinned sha through git's object store (symlink-safe) and mounted
  `:ro`, so the agent **cannot rewrite mid-run** the instructions it was handed — a property cwd
  discovery cannot offer at any trust level. `AGENTS.md` and `.pi/extensions` **are** discovered from
  cwd; see (c) and (f).
  **`appendSystemPrompt` is forbidden.** The smoke path is `pi -p`, **not** `pi --mode print` — that
  does not exist; `--mode` accepts `text|json|rpc` only. The internal mode union is
  `interactive|print|json|rpc` — there is no `tui`.
- **Why**: **Nearly everything that makes this contract dangerous is invisible at runtime**, and each
  hazard has its own mechanism. Read them as separate traps, not one — (a)–(f) are the loader's own, and
  (g)–(k) were added as the runner grew the meter, the staged-package tier, and the discovery relaxation.

  **(a) `appendSystemPrompt` replaces discovery.** It does not compose with it. The `??` means the
  persona baked at `~/.pi/agent/APPEND_SYSTEM.md` is never looked for. No error, no warning, the job
  succeeds, and the only symptom is an agent that quietly ignores its standing rules.
  `appendSystemPromptOverride` receives the discovered content as `base` and is applied *after*
  discovery, so it is the only path preserving both.

  **(b) `appendSystemPromptOverride` is a `DefaultResourceLoader` option, not a `createAgentSession`
  option.** It is reached only by constructing the loader yourself and passing it as `resourceLoader`.
  This is the one trap here that is *not* silent — TypeScript's excess-property check rejects it on an
  object literal — but only if the options are written inline and not widened through a variable.

  **(c) `noContextFiles` and `noExtensions` are now `false` ON PURPOSE, and the value is the decision.**
  Both default to `false` in pi, so the runner's setting them explicitly changes nothing at runtime — it
  is written out anyway, because this is the option whose history `CONST-NO-CONTEXT-FILES-MANDATORY` is
  about, and a value omitted is a value nobody can review. That constraint was **amended** to this
  posture: `/workspace` is always the base repo's **default-branch sha** (`prepare-github.mjs` resolves
  it, fetches that one commit, checks it out detached; a PR's `head`/`base` are data in `event.json` and
  never a clone ref), so a workspace file is merge-gated content and may carry the agent's standing
  instructions. **This is a relaxation, and the trap it leaves behind is the inverse of the old one**: the
  old failure was forgetting to build the loader at all and loading `AGENTS.md` by omission; the new one
  is assuming the *rest* of the loader is equally forgiving. It is not — (d), (e) and (f) all still bite,
  and (e) bites harder than it did. Note also what did **not** move: `CONST-ISSUE-TEXT-IS-DATA` is
  untouched, and webhook issue/PR/comment text is still data in the user prompt. Only repo **files**
  changed status.

  **(d) `createAgentSession` does not `reload()` a loader you pass it.** `reload()` runs *only* inside
  the `if (!resourceLoader)` branch. `reload()` is the method that populates the persona;
  `getAppendSystemPrompt()` is a plain getter with no lazy load. **So (c) forces you to construct your
  own loader, and constructing your own obliges you to call `reload()` yourself — the two constitutional
  constraints collide exactly on the trap.** Omit it and the persona is silently empty: no error, no
  log, job succeeds. This is the second known path to the failure this project fears most, and nothing
  at runtime will ever report it — see `REQ-UPSTREAM-CONTRACT-TESTS`.

  **(e) A trusted project's `.pi/APPEND_SYSTEM.md` SHADOWS the baked guardrails — it does not layer.**
  **This one got MORE reachable, not less, when the flags in (c) relaxed** — read it as live, not
  historical. The project **is** trusted (see (f)), and that is the sole gate on this path.
  `discoverAppendSystemPromptFile()` early-returns the project path when the project is trusted, and
  **never looks at the global one**. So "bake guardrails at `~/.pi/agent/APPEND_SYSTEM.md` and let the
  project add its own" is **incoherent**: the project's file would replace ours, silently, and the job
  would succeed. This is the *third* independent path to the persona-vanishing failure, after the `??`
  trap (a) and the missing `reload()` (d).
  **The fix removes the whole class**: read the guardrails **explicitly** from a path we own
  (`/opt/pi-dispatch/HARD_RULES.md`, outside `agentDir`) and prepend them in the override. Then no
  discovery result can shadow them, because discovery is no longer how they arrive. `base` becomes
  irrelevant and the override ignores it.

  **(f) We never CALL `resolveProjectTrust` — and the project is trusted anyway, by default.** These are
  two different facts and an earlier revision of this entry collapsed them into "project trust is never
  granted, and is not needed", which read as a safety property the code does not have. Precisely:
  `reload({ resolveProjectTrust })` is the only way we could *set* trust, and we do not pass it — but
  `SettingsManager.fromStorage` takes `options.projectTrusted ?? true` and `SettingsManager.inMemory`
  forwards no options, so the manager the runner builds reports the project **TRUSTED** from the first
  call. Not granting is not revoking.
  **That default is load-bearing now, and it was inert before.** While `noSkills`/`noExtensions` were
  both `true`, project-resource discovery was suppressed and trust had nothing to gate — the old wording
  was harmless because it described a path nothing walked. With `noExtensions: false` it is exactly this
  default that makes `addAutoDiscoveredResources`' `if (projectTrusted)` branch fire and load
  `/workspace/.pi/extensions`. **So if a future pi flips that default to untrusted, repo extensions stop
  loading and nothing reports it**: no error, no diagnostic, a clean exit 0 by a job missing capability
  its flow expected. The loader tests therefore pin the **outcome** (the discovered factory ran), never
  the flag — a test asserting `noExtensions === false` would stay green through that whole failure.
  What trust does **not** reach: `additionalSkillPaths` / `additionalExtensionPaths` are merged in **both**
  the `noSkills`/`noExtensions` branches and are **not** trust-checked at all, so with `noSkills: true`
  the skills are *exactly* what we hand it and nothing from the tree — that half of the old wording
  survives intact. Trust also routes `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`, which is why (e) is a
  live trap rather than a historical one, and why the guardrails are read explicitly instead.

  **(g) Never reach `@earendil-works/pi-ai` by bare specifier — and *what* a bare specifier does instead
  depends on which environment you are in.** Wherever the **worker's** dependencies are installed as well
  (a dev checkout, the contract-tests job), pi-ai is on disk **TWICE** with **SEPARATE module-level
  registries**: the hoisted `node_modules/@earendil-works/pi-ai`, which is the worker's declared dependency,
  and the nested `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`.
  **pi-coding-agent uses the NESTED one**, so `import "@earendil-works/pi-ai"` from runner code is a
  **silent no-op**: it binds the hoisted registry, registers, reports success, and meters nothing, while
  `import.meta.resolve` names a path that looks right and is not the live one. The **job image** is the
  other case, and it is the one the runner actually runs in: it installs the **runner's** dependencies only
  — `image/runner/package.json` declares `@earendil-works/pi-coding-agent` and `@playwright/cli`, never
  pi-ai — so the nested copy is the **ONLY** copy and that same bare specifier does not resolve at all
  (`ERR_MODULE_NOT_FOUND`, not a wrong binding).
  **One invariant covers both, and it is the one to hold onto**: never reach pi-ai by bare specifier — go
  through `modelRegistry.registerProvider`, and let a **runtime mutation probe** decide which module object
  the registry actually writes to (register an inert provider through the `ModelRegistry`, then ask each
  candidate module whether it can see it). Path inspection cannot settle the dual case and has nothing to
  inspect in the single one. This is why `run-job.mjs` carries **no pi-ai specifier at all** (a test guards
  the file for that string), why the meter loads its candidate by dynamic import in a proved order (nested
  first), and why `resolvePiAiCompat` wraps **both** lookups in a `tryResolve`: an unresolvable candidate is
  **skipped, not thrown**, which is exactly what makes one implementation correct in the image and in a dev
  checkout. The dual layout is pinned where it is true — `image/runner/test/pinned-api.test.mjs`, in the
  contract-tests job's full workspace install — and the image job asserts the invariant instead, by calling
  `resolvePiAiCompat` inside the built container.
  **Which job image, now that there can be more than one.** The two-environment framing above is *dev
  checkout* vs *the job image*, and the second is now a **class**: a trigger may name an operator-built
  image (`INT-TRIGGERS-FILE-CONTRACT`). Everything asserted here about `image/runner/package.json` — pi-ai
  nested, never declared, therefore the only copy — holds for **an image built from this repo's
  `image/Dockerfile`**. An image assembled another way could have pi-ai hoisted, deduped, or present twice,
  and these layout claims would simply not describe it. **That costs nothing, and it is the point of the
  invariant**: the runner never reads the layout, it registers through `modelRegistry.registerProvider` and
  lets the runtime probe decide. What does **not** survive is the *assertion*: the `image` CI job proves the
  property for the tag it builds; for a foreign image nothing in this repo proves anything (`OQ-012`).

  **(h) `resetApiProviders()` WIPES the registry, so a raw registration cannot be install-once.** It is
  what `AgentSession.reload()` calls. Registering through `modelRegistry.registerProvider` is what makes
  `ModelRegistry.refresh()` **re-apply** our wrappers instead of dropping them; a bare
  `resetApiProviders()` re-applies nothing, which is why an unref'd re-arm interval (plus the deterministic
  `arm()` after `createAgentSession`) exists at all. Two consequences worth stating: overriding a
  **builtin** api id flips compat's `shouldUseBuiltinModels` to false, so the wrapper must reproduce the
  catalog path rather than blindly delegate (two of the builtin providers substitute baseUrl placeholders
  and inject headers in that layer); and `refresh()` hands back **fresh** provider objects, so
  "did we already wrap this?" is answerable only by object identity, never by api id.

  **(i) Skill precedence is decided by `skillsOverride`, not by path order -- and there are now THREE protected roots, `/job/pi/skills`, `/job/trigger-skills` and `/opt/pi-global/skills`, consulted in that order (`REQ-PER-TRIGGER-SKILLS`).** `additionalSkillPaths` sets
  the order *among our own* paths (repo before overlay), but pi builds `skillPaths` as
  `mergePaths(cliEnabledSkills, additionalSkillPaths)` — the paths a staged package contributes through its
  `pi` manifest come **first** regardless of where the package was listed in `additionalExtensionPaths` —
  and `loadSkills` is **first-path-wins**, keeping the first skill of a given name and dropping every later
  one to a `{type:"collision"}` diagnostic. So on the raw load a package's skill takes the repo's name.
  `DefaultResourceLoaderOptions.skillsOverride` is the seam that settles it: a declared option on the
  pinned loader, invoked with `{skills, diagnostics}` the moment `loadSkills` returns and **before the
  loader stores anything**, whose return value is what the loader keeps. The runner uses it to put the
  protected skill back in force, building the substitute from pi's **public** `loadSkillsFromDir({dir,
  source: "path"})` — the same loader `loadSkills` itself uses for an explicit path — so the skill that ends
  up in force is exactly what pi would have kept had the package never shipped the name. pi's own collision
  diagnostic is left untouched (it is the true record of the raw load, and the runner reads it to report the
  attempt); the override appends its own diagnostic naming the enforced winner, so both stages are on the
  record. A job with no staged packages passes the loaded set through unchanged.

  **(j) `extensionsOverride` is the recursion guard, and it does LESS than its name suggests.** Turning
  on extension discovery (c) means a serviced repo's `/workspace/.pi/extensions` loads — and **this repo
  ships one**, `.pi/extensions/dispatch.ts`, a two-line re-export of the admin extension, in a deployment
  that services this very repo. Loaded into a job, it hands the model `dispatch_run` (enqueues a **paid**
  job), `dispatch_set` (moves the daily cap) and the pause/resume/trigger writes, driven by a session
  whose prompt carries adversarial issue text — the same recursion vector `import-pi` refuses to copy and
  the package stager refuses to stage. `DefaultResourceLoaderOptions.extensionsOverride` is the analogue
  of `skillsOverride`: a declared option at the pin, invoked on the `LoadExtensionsResult` **before the
  loader stores anything**, and `createAgentSession` builds its `ExtensionRunner` from
  `resourceLoader.getExtensions().extensions` — so an extension removed there registers no tool, receives
  no event, and contributes no command.
  **Two signals, because either alone leaves the case open.** An entry-**NAME** pattern (mirroring the
  worker's `ADMIN_RE`; matched against the entry name, never the full path, or a checkout that merely
  *sits under* a directory called `pi-dispatch` would have every extension dropped), and a `^dispatch_`
  **TOOL-SURFACE** check. The second is the one that actually closes this repo's case: `dispatch.ts` is a
  name no pattern would flag. **What it does NOT do, stated because the seam invites the opposite
  assumption**: discovery still resolves the file, jiti still imports it, and its factory has **already
  run** by the time the override is called (`loadFinalExtensionSet` → `extensionsOverride`, in that
  order). Module-level side effects of the import are bounded by the container, not by this layer. Two
  further honest limits: a serviced repo whose own extension registers a `dispatch_*` tool **loses it**
  in job containers (a loud, logged drop the operator can rename around — traded against silent paid
  recursion), and an admin re-export that is renamed **and** re-exports under other tool names is out of
  reach of both signals. It is a **filter, not a refusal**: refusing the job would make self-hosting the
  one thing this project cannot do.

  **(k) `noSkills` stays `true` while the other two relaxed, and the reason is mechanical.** Not caution,
  and not a trust judgement — it was *verified* that flipping it breaks things. The repo's skills already
  reach the agent at `/job/pi/skills`, materialised from the pinned sha with `git cat-file` (no working
  tree, so no symlink following) onto a read-only mount. Discovery registers every one of them a **second
  time** under `/workspace/.pi/skills`, and pi's `skillPaths` in the discovery branch is
  `mergePaths([...cliEnabledSkills, ...enabledSkills], additionalSkillPaths)` — the **discovered** copy
  ahead of ours — with `loadSkills` first-path-wins. So the mount stops being the copy in force and is
  demoted to a `{type:"collision"}` diagnostic, and the writable working-tree copy is what the agent
  gets. It also feeds garbage to (i): `skillsOverride` decides between package roots and protected roots
  and has no case for the same protected skill arriving twice. Same content, no benefit, real breakage.

  `modelRegistry.find(provider, modelId)` is a **method**, not a free function; there is no exported
  `getModel`. Pin the model explicitly: with `model` omitted, pi picks from settings and provider
  defaults, which is nondeterministic across images and silently changes cost per job. A missing model
  yields a fallback message on the *result*, not a throw — validate and fail loudly.
  `SessionManager.inMemory()` because the container is ephemeral: session storage would write to a
  filesystem that is about to cease existing.
  `SettingsManager.inMemory()` is load-bearing beyond the retry pin: it writes our settings to the
  **global** scope of a storage with **no project file**, so a serviced project's `.pi/settings.json` is
  never read and **cannot override our spend controls**. `SettingsManager.create(cwd, agentDir)` would
  read it and `deepMergeSettings(global, project)` lets project win. Use `inMemory`. Deliberately.

  The complete option set **at 0.80.7** is `cwd`, `agentDir`, `authStorage`, `modelRegistry`, `model`,
  `thinkingLevel`, `scopedModels`, `noTools`, `tools`, `excludeTools`, `customTools`, `resourceLoader`,
  `sessionManager`, `settingsManager`, `sessionStartEvent`. `OQ-005`'s migration replaces the first two
  with an async `modelRuntime` and **has not shipped** — it exists only on `main`.
- **Evidence (pinned artifact — authoritative)**: `npm @earendil-works/pi-coding-agent@0.80.7 →
  dist/core/sdk.d.ts → CreateAgentSessionOptions` — `authStorage?: AuthStorage` ("Default:
  AuthStorage.create(agentDir/auth.json)"), `modelRegistry?: ModelRegistry` ("Default:
  ModelRegistry.create(authStorage, agentDir/models.json)"); **no `modelRuntime` field, and no
  `model-runtime` module in `dist/` at all** · `→ dist/core/model-registry.d.ts → find(provider, modelId)`,
  `hasConfiguredAuth(model)`, `getAvailable()`, `getAll()`, `static create(authStorage, modelsJsonPath?)`
  · `→ dist/index.js` — `AuthStorage` and `ModelRegistry` are value exports; `ModelRuntime` is absent ·
  `→ dist/core/resource-loader.d.ts` — `noContextFiles`, `noSkills`, `noExtensions`,
  `additionalSkillPaths`, `additionalExtensionPaths`, `appendSystemPromptOverride` all present at the pin,
  as are `extensionsOverride` and `skillsOverride` (`:78-79`) · `→ dist/core/resource-loader.js:267-269`
  (the `noExtensions` branch: discovered paths merged **after** ours) · `→ :279` (`extensionsOverride`
  applied to the result, before the loader stores it) · `→ :281-283` (the `noSkills` branch: discovered
  skills would be ordered **before** `additionalSkillPaths`) · `→ :455` (`skillsOverride`) ·
  `→ dist/core/settings-manager.js:153,166-171` (`fromStorage` takes `options.projectTrusted ?? true`;
  `inMemory` forwards no options — the project is trusted by default) ·
  `→ dist/core/package-manager.js:1935-1946` (the `if (projectTrusted)` branch that discovers
  `.pi/extensions`)
- **Evidence (HEAD — explains behaviour, does NOT establish the pin contains it)**:
  `earendil-works/pi @ 5e336cf → packages/coding-agent/src/core/sdk.ts:33-80`
  (option set; no append fields, `resourceLoader?: ResourceLoader`) · `→ sdk.ts:164` (`createAgentSession`
  is async) · `→ sdk.ts:176-180` (default loader is built
  **and `reload()`ed** only when none is passed) · `→ sdk.ts:187-217` (`findInitialModel` fallback;
  `modelFallbackMessage` returned, not thrown) · `→ resource-loader.ts:122-157`
  (`DefaultResourceLoaderOptions`; `cwd`/`agentDir` **required**) · `→ resource-loader.ts:156`
  (`appendSystemPromptOverride?: (base: string[]) => string[]`) · `→ resource-loader.ts:463-470`
  (`noContextFiles` gates `loadProjectContextFiles`) · `→ resource-loader.ts:480-482` (the `??`) ·
  `→ resource-loader.ts:286` (`getAppendSystemPrompt` is a plain getter) · `→ resource-loader.ts:338,489`
  (`async reload`, `this.loaded = true`) · `→ model-runtime.ts:293 → getModel(providerId, modelId)` ·
  `→ session-manager.ts:1479 → static inMemory()` · `→ args.ts:10 → type Mode = "text" | "json" | "rpc"` ·
  `→ args.ts:140` (`--print`/`-p` is a separate boolean) · `→ project-trust.ts:12` (`AppMode`)
- **Traces to**: `DES-PERSONA-VIA-APPEND-SYSTEM-MD`, `CONST-PERSONA-IN-CACHED-PREFIX`,
  `CONST-NO-CONTEXT-FILES-MANDATORY`, `REQ-UPSTREAM-CONTRACT-TESTS`, `OQ-005`
- **Acceptance**: Constructing the loader exactly as the runner does and calling `reload()`,
  `getAppendSystemPrompt()` contains both the persona sentinel and the per-flow sentinel;
  `getAgentsFiles().agentsFiles` **carries** `/workspace/AGENTS.md` and its content, while that content is
  **absent** from `getAppendSystemPrompt()` (pi emits it into `<project_context>`, after the append
  block); a workspace `.pi/APPEND_SYSTEM.md` does **not** displace the floor; a discovered repo extension's
  factory **ran**, while an admin-named or `dispatch_*`-registering one is **absent** from
  `getExtensions().extensions` and its drop is logged; and a repo skill resolves **once**, from
  `/job/pi/skills`. All assertable **offline, with no provider call** — the loader boundary is pure, which
  is what makes the scariest assertions in this project free.
  **The fully-assembled prompt is also assertable for free**, which `REQ-UPSTREAM-CONTRACT-TESTS`
  depends on. `buildSystemPrompt` is not exported from the package root (only its options type is), but
  an **inline extension** observing `before_agent_start` receives the complete assembled `systemPrompt`,
  and that event is emitted **strictly before** anything that can reach the network — so the assertion
  costs zero tokens. Register it via `DefaultResourceLoaderOptions.extensionFactories`:
  ```typescript
  const captured: string[] = [];
  const probe = { name: "assert-system-prompt",
    factory: (pi) => { pi.on("before_agent_start", (e) => { captured.push(e.systemPrompt); }); } };
  ```
  Unlike `subscribe()`'s listener, an extension handler **may be async and is awaited**.
  **Model IDs**: provider id is `"anthropic"`. Valid ids at the pin include `claude-opus-4-8`,
  `claude-sonnet-5`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`. **The unsuffixed ids are
  floating "(latest)" aliases; the `-YYYYMMDD` ones are pinned snapshots.** Prefer a dated id where one
  exists — a floating alias silently changes the model, and therefore the cost and behaviour, under a
  fixed pi pin, which is the same failure `CONST-PI-VERSION-PINNED` exists to prevent. Note the newest
  models have no dated variant in this catalog, so that is a real trade, not a free win.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → core/agent-session.ts:1213 → emitBeforeAgentStart`
  vs `→ agent-session.ts:1252 → await this._runAgentPrompt(messages)` (the only path to a provider
  request — assembly and emit both precede it) · `→ core/extensions/types.ts:686-696 →
  BeforeAgentStartEvent` (carries `prompt`, `images?`, `systemPrompt` **fully assembled**,
  `systemPromptOptions`) · `→ types.ts:1161 → ExtensionHandler` (may be async; awaited) ·
  `→ types.ts:1477-1483 → InlineExtension` · `→ resource-loader.ts:131` (`extensionFactories`) ·
  `→ packages/ai/src/providers/anthropic.models.ts` (auto-generated catalog) ·
  `→ packages/ai/src/providers/anthropic.ts:12-14 → envApiKeyAuth("Anthropic API key", ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])`
  — the OAuth precedence is baked into the provider definition too, independently of `env-api-keys.ts`

- **(l) Resume is not an option you pass, and four things about it fail quietly.** Verified against the
  pinned `0.80.7` tarball and pi's own `docs/`, not recalled.
  1. **There is no `resume`, `sessionId` or `continueSession` field** on `CreateAgentSessionOptions`. The
     JSDoc example in `dist/core/sdk.d.ts` showing `continueSession: true` does not describe this version.
     Handing `createAgentSession` a persisted `SessionManager` IS the mechanism, and pi's `docs/sdk.md`
     documents exactly that form; it then restores `agent.state.messages` itself. pi's interactive
     `/resume` is a **different** thing — `AgentSessionRuntime.switchSession`, which replaces the ACTIVE
     session mid-process. The runner prompts once and exits, so there is no active session to replace.
  2. **`SessionManager.open` THROWS on a non-empty file that does not parse** as a pi session, and the
     agent owns that mount. Unhandled, that classifies as exit 1 = retryable, so four bad bytes would burn
     every retry and repeat on every later job for the same key. The runner catches, quarantines and
     degrades — and the catch is safe **only** because a pre-spend check has already proven the mount is
     present and writable, so the sole remaining cause is content. It must never be widened to cover the
     other two, or a dead mount becomes a fleet that is green on every job and has silently stopped
     resuming.
  3. **`model` must stay explicit.** `createAgentSession` restores the model from the session *only when
     `options.model` is omitted*. The runner always passes it, so the pinned model wins — but omitting it
     would make a stored transcript silently choose the model, and therefore the cost.
  4. **`thinkingLevel` is NOT passed, and therefore IS restored from the transcript.** That is a live
     behaviour change nobody asked for: a `thinking_level_change` entry crosses jobs and changes spend.
     Named here rather than fixed, because changing it is a behaviour decision, not a bug fix.
  Plus one documented-but-inert knob worth pinning: **`PI_CODING_AGENT_SESSION_DIR`** is documented by pi
  (`docs/usage.md`, `docs/settings.md`) as the session-storage override and is **read by nothing in
  `dist/`** — `getDefaultSessionDir(cwd, agentDir)` consults only its arguments. It is a CLI-layer
  variable, so the session dir must be passed explicitly, and an operator who sets it gets silence.

## INT-RUNNER-EXIT-CODE-PROTOCOL

**container → worker, secret resolver → worker, and wait profile → worker.**

**Three participants, and one table each.** The vocabulary was one table with footnotes while every
participant spoke the same three codes; it is stated per participant since the third one arrived needing a
fourth. What has not changed is which codes each speaks, so a reader of either existing participant loses
nothing by the restructure.

**The container and the secret resolver (`REQ-TRIGGER-SECRETS`) speak the same three codes for the same
reason**: `0` carries the value on stdout, `1` says the manager could not be reached and is RETRIED, `2` says
the reference is wrong and is not. For both of them an unrecognised code is treated as `1`. Reusing this
vocabulary rather than minting a second one was deliberate: an operator writing a resolver is already told to
ask what their manager does to their exit code (`docs/secrets.md`), and folding every nonzero exit into a
refusal would permanently burn a delivery over a transient vault outage. The resolver has no table of its own
below because it needs none — read the container's and substitute "the value" for "the agent's work".

**The wait profile (`REQ-WAIT-FOR`, issue #230) is the first participant to need a code the other two do not
have.** It answers *whether to start*, and the honest set of answers to that question is four, not three: go,
never, could-not-tell, and **not yet** — which is neither a retry nor a refusal but a HOLD, a queue behaviour
this protocol did not have. That is what the fourth code buys, and it is the whole of what it buys: the three
shared codes keep their meanings everywhere, including in the wait profile's own table.

**Why a code here and not a `reason`, when the rule below is that new vocabulary rides `reason`.** That rule
was written for command jobs, whose new words describe a run that HAPPENED: there is an exit log line to carry
them and a run record they end up in. A wait profile has neither — while a job is held there is no container,
no `exit` line, and by `INT-RUN-HISTORY-FILE-CONTRACT` no record at all — so `reason` is not a channel it has,
and the rule's own mechanism is what is missing rather than its intent being overridden. The widening is
bounded by being per-participant: **no container and no resolver may emit `3`**, a container exiting `3` is
still an unrecognised code that infra-retries, and a resolver exiting `3` is still `unreachable`. Both are
test-pinned, because "we widened one participant's vocabulary" and "we changed what a `3` means" are one
refactor apart.

- **Contract, container → worker**:
  | Code | Meaning | Queue behaviour |
  |---|---|---|
  | `0` | Agent completed — **including** concluding "I cannot fix this" | Success. Never retried |
  | `1` | Infrastructure failure (container died, network, provider 5xx/429) | Retryable |
  | `2` | Budget or policy refusal (cap exhausted, turn budget hit, token budget hit) | Not retried |

  **A worker-initiated termination overrides the numeric code.** When the worker itself stops the
  container — `docker stop` on the 30-minute timeout (`cancelJob`) or on graceful shutdown, delivering
  SIGTERM (`143`) then SIGKILL (`137`) — the outcome is classified **POLICY, not retried**, keyed on the
  worker's own abort signal rather than the exit code, because a worker SIGKILL and a kernel OOM both
  surface as `137`. Retrying a worker-aborted job re-runs a wedged run into a second PR. This is distinct
  from the runner's clean in-process abort (turn budget / timeout observed inside the container, exit
  `2`) and from an **unbidden** OOM-`137` with no worker abort, which stays infra-retryable (`1` class).

  **The runner needs BOTH a `try`/`catch` AND `stopReason` handling — they cover disjoint failure sets.**
  `session.prompt()` is `Promise<void>`, so there is no return value to inspect; the terminal message is
  captured via `subscribe()` (`turn_end` / `agent_end`).

  | Failure | Surfaces as | Exit |
  |---|---|---|
  | **Our own precondition fails** — missing/malformed `PI_*` env, missing `/job/prompt.md`, unknown model | **throws a tagged `configError`** | `2` — deterministic; the worker passes the same bad value on every retry |
  | No API key for the provider | **throws** (preflight) | `2` — config error; retrying cannot fix it |
  | No model selected / unknown model | **throws** (preflight) | `2` — same |
  | Streaming without `streamingBehavior` | **throws** (preflight) | `1` — our bug |
  | `"Agent is already processing."` | **throws** (before the lifecycle try) | `1` — our bug |
  | Extension error in `before_agent_start` | **throws** (preflight) | `1` |
  | Provider 429 / 5xx / network death | `stopReason: "error"` | `1` — infra, retryable |
  | Our turn budget or timeout aborts | `stopReason: "aborted"` | `2` |
  | Our per-job **token budget** aborts | `stopReason: "aborted"` | `2` — `decideExit` intercepts it as `reason: "token_budget"` BEFORE the generic `"aborted"`, exactly as the turn budget is intercepted (`REQ-TOKEN-ACCOUNTING-AND-CAPS`) |
  | The **process-wide** token budget breaches mid-fanout (a subagent session's call trips it) | `stopReason: "aborted"` on the root — every later call **by any session** is answered with a synthetic aborted stream | `2` / `token_budget` — the same row as above by design: `decideExit` reads one `tokenAborted` flag and neither meter gets its own exit code, so an operator never has to learn which one fired |
  | Normal completion | `stopReason: "stop"` \| `"toolUse"` | `0` |
  | **Output truncated at the token limit** | `stopReason: "length"` | `0`, **but log it** — it is a completed run, not a silent failure, and must not be mistaken for either |

  `StopReason` is exactly `"stop" | "length" | "toolUse" | "error" | "aborted"` — enumerate all five. A
  default-to-`0` branch would map `"length"` to success without anyone noticing the agent was cut off.

  **Command jobs (issue #189, `run.command`) add three named reasons under the EXISTING codes — never a
  new code and never a new worker-level outcome** (the admin surfaces bucket outcomes into a closed set
  and silently drop unknowns, so new vocabulary rides `reason` on the exit log line):

  | Command-job event | Surfaces as | Exit / reason |
  |---|---|---|
  | The named command is not registered by any loaded extension | pre-prompt `getCommand()` miss → tagged `configError` | `2` / `command-unregistered` — deterministic, pre-spend, and forecloses pi's fall-through (an unregistered `/name` is not an error to pi: it would ride through template expansion into a paid model call) |
  | The handler ran and returned; no assistant message exists | `session.prompt()` resolves with no terminal | `0` / `command-completed` — before this reason, a SUCCESSFUL headless command was the retryable `no-terminal-message` shape, and the queue re-billed a success |
  | The handler THREW | pi swallows it (`handled=true`, clean resolve); observed only via `extensionRunner.onError` (`event: "command"`) | `1` / `command-error` — **retryable by explicit choice**: pi surfaces a message string, transient-vs-deterministic is undecidable, and the accepted cost (a deterministic extension bug retries until attempts run out) is recorded on `DES-COMMAND-ENTRY-POINT` |
  | The handler drove the model (`sendUserMessage`/`waitForIdle`) | a real terminal message exists | its `stopReason` verdict stands unchanged — a provider 429 inside a handler-driven turn stays `1`/retryable |

  Budget aborts keep first position over all of these. The `commands` entry in the image's
  `dev.pi-dispatch.capabilities` label is what tells the worker this protocol extension exists in a given
  image; a runner without it would classify every command job `no-terminal-message` and pay to retry it.

  The runner's `exit` log line carries two **read-only telemetry** fields beside the outcome — `turns` and
  `tokens` (`{ input, output, total, cost }`, the per-job usage totals). Both are recovered host-side
  (`parseExitTurns` / `parseExitTokens`) into the run record and **must not feed exit-code or retry
  classification** — that is this protocol's job. The catch-path exit line (a preflight throw, no session
  ran) omits both, so each parses to `null`.
  **`tokens` gained eight keys with the process-wide meter** (`REQ-TOKEN-ACCOUNTING-AND-CAPS`), and **not
  one of them feeds classification either**: `metered` (`true` from the process-wide meter, `false` from
  the `subscribe()` fallback — the flag that tells a reader whether the total covers every in-process
  session or only the root's turns), `rootTotal` / `otherTotal` / `looseTotal` (the attribution split;
  they sum to `total` exactly, and a non-zero `otherTotal` **is** the subagent spend a per-session bus
  cannot see), `sessions` (distinct session ids observed), `calls` (provider calls observed, not turns),
  `unresolved` (streams still unsettled when the job ended — non-zero means the totals are a **floor**, not
  a total) and `unpriced` (calls whose usage carried no finite cost; counted rather than guessed, because a
  silent `0` would read as "this call was free"). The four original keys keep their meaning and position,
  so a reader that only knows them is unaffected. The fallback line carries `metered: false` and the four
  originals only. The sibling `usage` key (the per-model ledger, `REQ-TOKEN-ACCOUNTING-AND-CAPS`) is the
  same class of read-only telemetry: recovered by its own validating parser (`parseExitUsage`), absent on
  the fallback and catch-path lines, and **feeding classification exactly as much as `tokens` does —
  not at all**.
  **`context` is a third sibling** (`{ tokens, window }`, issue #186): how full the session's context was
  when the run ended, read from pi's own `getContextUsage()` before the session is disposed. A sibling
  rather than a widening of `tokens` for the reason the ledger is one — `tokens` is a per-run BILLING
  snapshot with two possible producers, and occupancy is neither billing nor per-run. It feeds no
  classification either; it is recovered by `parseExitContext` and persisted beside the transcript so the
  NEXT job on that key can bound what it resumes into (`INT-SESSION-STORE-CONTRACT`). **Absent means
  absent, and never zero**: the key is OMITTED when pi has no context window for the model, and when a
  compaction has left pi's own count unknown, because a zero would be a denominator nobody computed. That
  omission also makes the field invisible to every existing consumer and to any image whose runner
  predates it, which is why it needs no `dev.pi-dispatch.capabilities` entry — capabilities are an
  INCLUSION list for what the host DEMANDS of an image, and there is nothing here for `verify-image.sh` to
  grep that would mean anything. The cost of that is stated rather than discovered: the bound this feeds
  is inert on an old image and stays inert forever on one that is never rebuilt.

- **Contract, wait profile → worker** (`run.waitFor`'s `profile` conditions):
  | Code | Meaning | Queue behaviour |
  |---|---|---|
  | `0` | The condition has cleared | The job starts |
  | `1` | I could not tell | **Held** — asked again later, and COUNTED as a fault |
  | `2` | This will never clear | Not retried. Terminal, `wait-refused` |
  | `3` | Not yet | **Held** — asked again later |
  | any other | treated as `1` | **Held**, counted |

  `1` holds rather than refusing because a check that could not answer has not answered *no*: reading an
  unreachable Jira as "this will never clear" drops a paid delivery over a transient outage, which is
  `CONST-RETRY-INFRA-ONLY` in the expensive direction and the same call the secret resolver makes.

  **The fault count is what keeps `1` and `3` from being one code wearing two hats**, and it exists because
  of `OQ-027`: most CLIs exit `1` for everything, so a permanently broken check — a typo'd `curl` exits `6`,
  a false `jq -e` exits `1` — would otherwise hold for the entire maximum wait, spawn a process every
  interval, and terminate with a reason blaming the CONDITION rather than the script. `PI_WAIT_MAX_FAULTS`
  consecutive faults terminate as `wait-unanswerable`, naming the profile. A `3` resets the count: a check
  that answered is a check that works. The happy side effect is that the naive one-liner an operator writes
  first (`... | grep -q ...`, which exits `1` when the pattern is absent) behaves correctly by accident — it
  holds, and the fault bound keeps that from being forever.

- **Why**: This exit code **is** the mechanism `CONST-RETRY-INFRA-ONLY` is implemented by. The worker
  has no other channel to distinguish "the agent ran and said no" from "the container died" — collapse
  them and you either burn money blind-retrying determinate outcomes, or you silently swallow real infra
  failures as if the agent had decided something. The counter-intuitive part is load-bearing: **`0` on
  "can't fix"** is correct, because from the queue's perspective the work was done. The agent's verdict
  is the product, not the failure.
  **Both obvious implementations are wrong, in opposite directions.** This is why the mechanism is
  specified rather than left to the coder.

  **Wrong #1 — `try`/`catch` alone.** Inside the agent loop, pi does **not** throw.
  `Agent.runWithLifecycle` wraps the run in
  `try { await executor(signal) } catch (error) { await this.handleRunFailure(error, signal.aborted) }`
  and `handleRunFailure` **does not rethrow** — it synthesises an assistant message carrying
  `stopReason: aborted ? "aborted" : "error"` and emits an ordinary terminal event sequence. So a 429, a
  5xx, a dead network, and our own abort **all resolve `await session.prompt(...)` normally**:
  ```js
  try { await session.prompt(text); process.exit(0); }   // exits 0 on EVERY provider failure
  catch { process.exit(1); }
  ```
  The queue records success, never retries, and the job did **nothing** — verbatim the failure class
  `CONST-PI-VERSION-PINNED` names as the worst available: *the queue still reports success*. It silently
  defeats `REQ-RUNNER-TURN-BUDGET` too: the budget aborts at N, `prompt()` resolves, exit `0`, and nothing
  downstream learns the budget fired.

  **Wrong #2 — `stopReason` alone, with no `try`/`catch`.** An earlier draft of this entry asserted *"pi
  never throws"* and forbade `try`/`catch` outright. **That was false.** `AgentSession.prompt()` runs a
  preflight that rethrows, and pi's own JSDoc says so: *"@throws Error if streaming and no
  streamingBehavior specified / @throws Error if no model selected or no API key available"*. Separately,
  `Agent.runWithLifecycle` throws `"Agent is already processing."` **before** its own try block, so that
  one escapes to the caller too. A runner without a `catch` dies of an unhandled rejection on a missing
  API key and exits with Node's default `1` — which this protocol defines as **retryable**, so the queue
  pays to retry a job that can never succeed.

  The split is the point: **preflight throws; the loop swallows.** Neither mechanism alone is sufficient,
  and there is no typed error class — classify caught errors by inspection, and loop outcomes by
  `stopReason`. For errors the runner raises *itself* (bad env, missing input), do not lean on inspecting
  pi's error vocabulary: **tag them** with the exit code at the throw site (a `configError` helper), so the
  classifier honours the tag instead of pattern-matching a string it controls. A regex tuned for "no
  model / no API key" will not match "invalid PI_MAX_TURNS", and that miss silently makes a config typo
  *retryable*.

  **`session.dispose()` in the `finally`.** Every official SDK example disposes; it is the only caller of
  the provider cleanup callbacks. Skip it and a provider transport can keep the event loop alive, hanging
  the container until the 30-minute timeout turns a completed job into a timeout failure — silent, and
  exactly the class this file exists to prevent.
  **The listener must be synchronous.** `_emit` is `for (const l of this._eventListeners) { l(event); }`
  — no `await`. An `async` listener is fire-and-forget, so a budget check that awaits anything is not
  guaranteed to run before the next turn. `session.abort()` returns a promise but flips the `AbortSignal`
  synchronously inside, so `void session.abort()` from a sync listener is correct and sufficient.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/agent/src/agent.ts:485-491`
  (`catch (error) { await this.handleRunFailure(error, abortController.signal.aborted) }` — no rethrow) ·
  `→ agent.ts:494-510 → handleRunFailure` (`stopReason: aborted ? "aborted" : "error"`, `errorMessage`;
  emits `message_start`/`message_end`/`turn_end`/`agent_end` and returns) ·
  `→ agent.ts:470-471` — `if (this.activeRun) { throw new Error("Agent is already processing.") }`,
  **outside** the try/catch, so it escapes to the caller ·
  `→ core/agent-session.ts:1242-1244` — `catch (error) { preflightResult?.(false); throw error; }`
  (**the preflight rethrow that refutes "pi never throws"**) ·
  `→ agent-session.ts:1099-1100` — JSDoc: *"@throws Error if streaming and no streamingBehavior
  specified / @throws Error if no model selected or no API key available (when not streaming)"* ·
  `→ agent-session.ts:1102 → async prompt(text, options?): Promise<void>` (**no return value**) ·
  `→ packages/ai/src/types.ts:380 → export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`
  (all five — note `"length"`) · `→ agent-session.ts:527-531 → _emit` (sync, unawaited) ·
  `→ agent-session.ts:2610-2614 → _isRetryableError` → `isRetryableAssistantError(message)` — classifies
  the **message**, not a thrown error
- **Traces to**: `CONST-RETRY-INFRA-ONLY`, `REQ-RUNNER-TURN-BUDGET`, `REQ-JOB-STATUS-COMMENTS`,
  `REQ-UPSTREAM-CONTRACT-TESTS`
- **Acceptance**: Given a runner that exits 0 after concluding no fix is possible, the job records
  success and does not re-run. Given a **simulated provider error**, the runner exits `1` — not `0`.
  Given a turn-budget abort, it exits `2` — not `0`. Both must be asserted: they are the cases the
  obvious implementation gets silently wrong.

## INT-CONTAINER-JOB-INPUTS

**worker → container.**

- **Contract**: `/job` mounted **read-only**. `/workspace` is writable; a **local** job additionally
  mounts `/outbox` (writable, `INT-OUTBOX-CONTRACT`); a **github** job does not.
  ```
  /job/prompt.md          task text (issue/PR payload, or the operator-supplied task), plus the
                          trigger's `run.instructions` in the envelope above the data region, if set
  /job/event.json         structured trigger context — written for EVERY job, github and local alike
                          (both shapes below)
  /job/pi/APPEND_SYSTEM.md         project persona  ─┐ materialised by the worker from the
  /job/pi/skills/<name>/SKILL.md   project skills,   │  project's .pi/ at the DEFAULT-BRANCH SHA,
  /job/pi/skills/<name>/<support>  materialised      │  via `git ls-tree -l` + `git cat-file blob
                                   WHOLE            ┘  <oid>`, never `fs.readFile`
  /job/trigger-skills/<name>/**    the trigger's INJECTED skills, copied from the worker-host directory
                                   `run.skillsDir` names. Present only when the trigger set it.
  ```
  **The guardrails are baked into the image** at a path outside `agentDir` and are **not** mounted.
- **What the container additionally reads from `/workspace`, and why it is not a `/job` input.** A job's
  `/workspace` is the base repo at its **default-branch sha** — `prepare-github.mjs` resolves that sha,
  fetches that one commit and checks it out **detached**, and a PR's `head`/`base` are `event.json` data,
  never a clone ref — so its files are merge-gated. pi therefore discovers two things from it natively
  (`CONST-NO-CONTEXT-FILES-MANDATORY`, amended; `INT-SDK-SESSION-OPTIONS`): **`AGENTS.md`** (and
  `CLAUDE.md`), landing in `<project_context>` *after* the append block, and **`/workspace/.pi/extensions`**,
  whose entries run as code. Neither is copied into `/job`, and that is the distinction the two mounts
  encode: `/job` is the **read-only, agent-untamperable** channel, read from the object store; `/workspace`
  is the writable checkout the agent is working in, and an agent that rewrites `AGENTS.md` mid-run has
  rewritten *its own* context — a merge-gated file it was already allowed to influence — not the
  instructions in `/job`.
- **`/session` is deliberately NOT a `/job` input**, and the reason is the distinction this entry already
  draws: `/job` is the **read-only, agent-untamperable** channel, read from the object store; `/session`
  is **agent-written by design** — pi appends to the transcript as the agent works. Putting it under
  `/job` would have required making part of that mount writable, which is the property `/job` exists to
  have. Its own contract is `INT-SESSION-STORE-CONTRACT`, and the symlink paragraph above is the
  precedent its `lstat` rule cites: the same attack, with the direction reversed.
- **A repo skill is materialised WHOLE, and bounded** (issue #60). The allowlist accepts
  `.pi/APPEND_SYSTEM.md` (an exact path) and **every declared file under `.pi/skills/<name>/`**, not just
  each `SKILL.md`. It used to accept only the latter, which meant a skill shipping `references/`,
  `scripts/` or templates had those files dropped by a bare `continue` — and **nothing failed**: pi's own
  prompt text instructs the model to *"resolve it against the skill directory"*, so the skill loaded, read
  correctly, and pointed the agent at files that were not in the container. A confidently wrong agent, not
  an error.
  - **Grammar.** The tree path is split on `/` and every piece is validated independently, then the output
    path is **rebuilt from the validated pieces**. This is stronger than the single regex it replaced: any
    other separator (a backslash, a NUL, a CR) survives *inside* a piece and is refused by the anchored
    charset, and a literal `..` piece is refused by the leading-alphanumeric rule, which is also why no
    separate `!= ".."` test is needed. The skill **directory name** keeps the lowercase-only
    `SKILL_NAME_RE` shared with the flow gate; only the segments **below** it are case-insensitive,
    because `SKILL.md` and `README.md` are the point. Windows reserved device basenames (`CON`, `NUL`,
    `COM1`…) are refused: writing one on Windows targets a device and produces no file and no error.
  - **A subtree declaring no `SKILL.md` anywhere beneath it is not materialised**, because pi registers a
    skill only where a literal `SKILL.md` exists and loose `.md` files load only at the skills root — so
    those bytes could never be referenced, and copying them would be a data-dump channel into the job
    container that never has to look like a skill. The test is "anywhere beneath", not "at the root",
    because pi keeps recursing while a directory has no `SKILL.md`: `.pi/skills/group/sub/SKILL.md` is a
    real skill, and a root-only rule would recreate this defect one level down.
  - **Executable blobs (`100755`) stay rejected**, so a skill's `scripts/` arrive non-executable and are
    invoked as `bash script.sh`. `/job` is `:ro` and every file lands `0444`, so accepting the mode and
    writing `0444` anyway would accept what the repo asked for and silently strip it; writing `0555`
    instead would have the worker grant execve on repo bytes. The drop is loud (the file is absent, or the
    invocation says `Permission denied`), which is the opposite of the silent class above.
  - **Bounded, and decided before anything is spent.** Enumeration is a single `git ls-tree -r -l -z`, and
    `-l`'s size column lets every cap be evaluated **before the first `cat-file` and before the first
    write** — `CONST-BUDGET-BEFORE-TOKENS`' ordering one layer down. The caps are 256 files, 64 per skill,
    1 MiB per file, 8 MiB total, 4 path segments below the skill name, and 200 characters of output path;
    the listing itself is separately bounded at 1 MiB, because the caps are computed *from* it and so
    cannot bound it. A breach is a determinate **policy refusal** (`pi-too-many-files`,
    `pi-file-too-large`, `pi-too-large`, `pi-path-collision`) that returns rather than throws, writes
    nothing, and is never retried. Truncating instead was rejected: a truncated skill **is** the defect
    above, and which files survived would be decided by git's tree order. The `pi-` prefix on those
    tokens is load-bearing rather than decorative: the nested `session.reason` enum in
    `INT-RUN-HISTORY-FILE-CONTRACT` already carries a bare `too-large`, and two enums in one record
    sharing a token is how a reader misattributes a refusal.
  - **`pi-path-collision`** refuses two paths differing only in case (`README.md` beside `readme.md`), or
    a file colliding with another file's directory prefix. A case-insensitive host collapses them onto one
    file and the second write `EACCES`es against the `0444` first one — unreachable while each skill was
    one lowercase-named file, and reachable now.
  - Per-entry problems are **skipped and counted**, never refused: a non-`100644` mode, a leading-dot name
    (parity with pi's own loader), an out-of-charset or over-long segment, a device name, an over-deep
    path. A refusal keyed on a *filename* would be a denial-of-service surface for exactly the population
    this file treats as the threat: one committed `.DS_Store` would brick every job for that repo.
- **`/job/trigger-skills/` is the one `/job` input that does NOT come from git** (`REQ-PER-TRIGGER-SKILLS`,
  issue #60), and the asymmetry is worth stating because the rest of this entry argues so hard for the
  object store. `.pi/` is read by oid because the serviced repo is only trusted at maintainer level and the
  read must be symlink-safe against a tree an attacker can shape. `run.skillsDir` is **operator-authored
  deploy-time config** named in a reviewed file, the same trust class as the global overlay, so there is no
  hostile tree to defend against -- what remains is the ordinary filesystem hazard, and the copier answers
  it the same way the materialiser does: `lstat` (never `stat`, which follows), regular files only,
  destination paths rebuilt from validated segments, containment re-checked, counts and bytes bounded.
  It arrives on the **existing** `/job:ro` bind rather than a mount of its own, so the container sees it
  read-only and `CONST-ISOLATION-CONTAINER-PER-JOB`'s mount enumeration is unchanged. Absent unless the
  trigger set the field, so a job without one has a byte-identical `/job` to one prepared before the
  feature existed.
- **`/job/pi/extensions` is NOT written, and the seam is deliberate.** An earlier revision of this list
  carried it; the worker's materialiser emits `pi/APPEND_SYSTEM.md` and the declared files of
  `pi/skills/<name>/`, and **never** `extensions/`, so the path documented a file that never existed.
  (The premise widened in issue #60 when whole skill directories began to materialise; the conclusion did
  not.) Repo extensions stay
  unmaterialised, and that is now a **routing** fact rather than a refusal: they arrive by cwd discovery
  instead, which means there is exactly **one** path a repo extension has ever had and no double-load to
  reconcile. The runner still lists `/job/pi/extensions` in `additionalExtensionPaths`
  (`INT-SDK-SESSION-OPTIONS`) for symmetry; today it resolves to a permanent, unread
  `"path does not exist"` entry in `extensionsResult.errors` on **every** job. That permanent entry is
  exactly why the staged-package existence check is **scoped to the package roots** rather than surfacing
  pi's error list wholesale: an always-populated error channel cannot be used to detect anything, so
  `assertPackagePathsExist` checks the roots it was handed, itself, before the prompt is read and before
  any spend.
  **The admin extension is the one thing discovery may not deliver.** A serviced repo can ship one — this
  repo does — so the runner drops admin-like entries at pi's `extensionsOverride` seam before the session
  is built (`REQ-ADMIN-VIA-PI-EXTENSION` Scope, trap (j) in `INT-SDK-SESSION-OPTIONS`).
- **Operator-staged pi packages** reach a job as `PI_PACKAGES` — a `":"`-delimited list of **absolute
  container paths** under `/opt/pi-global/packages/<dir>`, emitted only for a trigger that opted in
  (`INT-TRIGGERS-FILE-CONTRACT`) — **not** as a `/job` input. They live inside the operator overlay's
  existing `:ro` mount (`REQ-GLOBAL-PI-OVERLAY`, `INT-PI-PACKAGES-FILE-CONTRACT`); `/job` remains the
  per-job, per-repo channel and carries none of them. A relative entry, a `..` segment, or a path that did
  not mount is a **pre-spend** `configError` (exit `2`), because pi **skips** an unresolvable local package
  source with no error and no diagnostic — so an unmounted package would otherwise run the flow to a clean
  exit `0` without the tools it was written for.
- **`/job/event.json` — both shapes.** Written for **every** job, `0o444` like everything under `/job`,
  one file per concern — trigger context lives here, never merged into the prompt file.
  - A **github** job gets the webhook payload subset — an `issue` OR a `pull_request` body per the target
    discriminator (`INT-WEBHOOK-PAYLOAD-SUBSET`) — plus four additions. `comment: { body,
    author_association }`, comment-triggered jobs only: the invoking comment, carried on the job's
    `trigger`; the body is untrusted user-authored data permitted in `/job` and the prompt's fenced data
    region **only** — never in worker logs or the run record (`no-pii-in-logs`,
    `CONST-ISSUE-TEXT-IS-DATA`). `review: { id, body, state, author_association }`, review-triggered jobs
    only (issue #66): the invoking review, on the same terms — `body` is untrusted data with the same
    permitted placements, while `id`, `state` and `author_association` are metadata that reach
    `event.json` and never the prompt. `sender: { id }` — **no `login`**: the subset never extracted it, so the
    key was written but never populated, and it is now not written at all. And `matched: { index, type,
    label | phrase | action }` — **HARNESS-COMPUTED** metadata, the filter's own decision record and not a
    webhook payload field: `index` is the 0-based position of the winning entry in the raw `triggers.json`
    `triggers` array (cron entries counted — the file index is the rule's identity), `type` is that
    entry's `on.type`, and the third key names what satisfied the rule — for `label` the label that hit
    (first `any` hit, else `all[0]`), for `comment` the configured `phrase`, for `pull_request` the
    `action`. `matched` does **not** enter the prompt. Since issue #54 the harness also persists
    `matched.index` and `matched.type` — and only those two — host-side on the run record as
    `triggerIndex`/`triggerType` (`INT-RUN-HISTORY-FILE-CONTRACT`); the third key stays in `event.json`
    alone, inside the container, because it can carry collaborator-applied text.
    On a CLOSE-triggered job (issue #231) `matched` additionally carries `number` (the closed item's
    number, on the `issue` shape — a harness-computed integer, never payload text) and, only when the
    rule was a one-shot, `once: true` — conditional keys on `reviewState`'s absent-stays-absent terms,
    so every non-close job's `matched` is byte-identical to before. `once` is what the worker's disarm
    hook keys on, and `number`/the job's own target number are the identity the disarm re-checks; both
    are the admissible integer/boolean class, so the run record's PII-free property is untouched.
  - **On a review-triggered job `matched.action` and the record's own `action` deliberately DIFFER**, and
    this is the first GitHub case where they do. The record's `event`/`action` pair is byte-for-byte what
    GitHub sent (`pull_request_review` / `submitted`); `matched.action` is the `triggers.json` word that
    fired (`review_submitted`), which GitHub never sent on any event. That follows from what each object
    is for — the record says what the forge said, `matched` names the rule the operator wrote — but it
    means "for `pull_request` the `action`" above must be read as the rule's action, not the payload's.
  - A **local** job gets one of three `source`-discriminated shapes — naming the fields IS the contract:
    ```
    cron:    { source: "cron", trigger: { id, pattern }, folder: <basename>, sha: <folder HEAD>,
               scheduledFor: <ISO>|null, previousRunAt: <ISO>|null }
    manual:  { source: "manual", folder: <basename>, sha }   // CLI `pi-dispatch run` / admin dispatch_run
    chain:   { source: "chain", folder: <basename>, sha }    // outbox-chained child
    ```
    `folder` is the **basename only** — the full host path embeds the operator's OS account name and
    `/job` is agent-readable, the same restraint `INT-RUN-HISTORY-FILE-CONTRACT` applies to
    `local:<basename>`. `sha` is the folder's HEAD at prepare time. `scheduledFor` derives from the BullMQ
    `repeat:<id>:<millis>` job id; `previousRunAt` is the prior fire's `endedAt` (`startedAt` fallback),
    looked up read-only from the run-history files by filename (`INT-RUN-HISTORY-FILE-CONTRACT`). The
    local task prompt names `/job/event.json` in one harness line — discovery only, mirroring the github
    prompt.
- **Why the worker materialises `.pi/` instead of letting pi discover it**: not because the checkout is
  untrusted — it is the default-branch sha either way — but because materialising buys two properties
  discovery cannot. **The agent cannot rewrite them mid-run**, since `/job` is `:ro` while `/workspace` is
  the tree it is actively editing; and the read is **symlink-safe**, because it goes through git's object
  store rather than the filesystem. Both matter independently of trust. Read them with
  `git show <sha>:.pi/...` — `fs.readFile` off the clone follows **symlinks**, and `loadSkillsFromDir`
  follows them too (`entry.isSymbolicLink()` → `statSync`), so a symlinked `SKILL.md` or
  `APPEND_SYSTEM.md` would otherwise pull a worker-host file into the system prompt. The instructions stay
  pi-native (`SKILL.md`, the Agent Skills spec — not a bespoke format we'd have to reimplement) on the way
  through. **This is also the whole reason `noSkills` stays `true`** while context files and extensions are
  discovered: were it off, pi would register each repo skill a second time from `/workspace/.pi/skills` and
  — first-path-wins, discovered copy first — the writable working-tree copy would take the mount's place.
- **Why**: Read-only because the container is the **untrusted side**. The agent must not be able to
  rewrite the instructions it was handed — that filesystem permission is what makes
  `CONST-ISSUE-TEXT-IS-DATA` *enforceable* rather than merely asked-for. The persona is baked rather than
  mounted so that even a total compromise of `/job` cannot reach the system prompt: the trusted prefix
  is not reachable from the untrusted side at all.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → core/resource-loader.ts:417-418` —
  `additionalSkillPaths` is merged in **both** the `noSkills` and `else` branches and is **not**
  trust-checked · `→ resource-loader.ts:979-991 → discoverAppendSystemPromptFile` (project path
  **early-returns**, shadowing the global) · `→ resource-loader.ts:346-350` (`resolveProjectTrust` is the
  only way *we* could set trust — the in-memory default is already **trusted**, which is what makes
  extension discovery fire; see `INT-SDK-SESSION-OPTIONS` trap (f)) ·
  `→ core/skills.ts:168-200 → loadSkillsFromDir` (layout is `**/SKILL.md`;
  symlinks followed) · `→ skills.ts:67-81 → SkillFrontmatter` (`name`, `description`,
  `disable-model-invocation`; validated "per Agent Skills spec")
- **Traces to**: `CONST-ISSUE-TEXT-IS-DATA`, `CONST-ISOLATION-CONTAINER-PER-JOB`,
  `DES-PERSONA-VIA-APPEND-SYSTEM-MD`, `INT-SDK-SESSION-OPTIONS`
- **Acceptance**: A write to any path under `/job` fails from inside the container; `/outbox` is writable
  for a local job and absent for a github job. A hostile symlink at
  `.pi/APPEND_SYSTEM.md`, `.pi/skills/x/SKILL.md` **or `.pi/skills/x/references/y.md`** in the serviced
  repo results in **no host file content anywhere** in `/job` or the assembled prompt, and a symlinked
  *directory* or a gitlink inside a skill produces nothing at all.
  Given a repo skill shipping `references/` and `scripts/`, every declared file arrives under
  `/job/pi/skills/<name>/`, `0444`, with its executable blobs absent. Given a `.pi/skills/<x>/` that
  declares no `SKILL.md` anywhere beneath it, nothing under it arrives. Given a `.pi/` over any cap, the
  job is refused with a `pi-` reason, **no file is written and no blob is read**, no budget slot is
  burned, and the refusal is not retried.

## INT-CONTAINER-RUNTIME-CONTRACT

**worker → docker daemon.**

- **Contract**:
  - **Which image — and why this contract is now a checklist rather than a description.** This contract is
    written against *an* image, never against `pi-job:latest`, and until now that was true by accident:
    there was exactly one image and this repo built it. The worker resolves the tag **per job**
    (`job.image ?? PI_JOB_IMAGE`; `INT-TRIGGERS-FILE-CONTRACT`, `DES-PER-TRIGGER-JOB-IMAGE`), so everything
    below is **the conformance checklist any image must satisfy to be nameable in `run.image`**. Each item
    is something the worker *assumes and does not verify at run time*, and — the reason this list exists at
    all — **every one of them fails silently or late**: a non-root runtime user with a **writable
    `~/.pi/agent`** (else EACCES on pi's first credential write, inside the container, at run time, on a
    path no Dockerfile hints at); an `ENTRYPOINT` that is the runner and honours
    `INT-RUNNER-EXIT-CODE-PROTOCOL` (an entrypoint that exits Node's default `1` on a policy failure makes
    the queue pay to retry a job that can never succeed); the **pinned pi version**
    (`CONST-PI-VERSION-PINNED` — a stale pi is the silent-no-op-that-reports-success failure class); the
    baked env facts (`PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_MCP_BROWSER`, `PLAYWRIGHT_MCP_SANDBOX`) for any
    flow doing frontend work; **root-owned, agent-unwritable guardrails** at
    `/opt/pi-dispatch/HARD_RULES.md` (an agent that can rewrite its own safety floor has none); fonts
    (absent is silent — plausible screenshots containing no legible text); and the **loader posture** in
    `image/runner/src/loader.mjs`, which `CONST-NO-CONTEXT-FILES-MANDATORY` records is switchable only by a
    two-line source edit plus an image rebuild — i.e. **the security posture is per-image**, so a
    deployment that turned discovery off for multi-tenancy in one image **has not turned it off in
    another**, and that carve-out must be re-made in every image it names. `docs/job-image.md` is the
    operator-facing form of this list; the `image` CI job is its executable form; `OQ-012` is the honest
    statement that nothing in this repo enforces it.
  - Flags: `--pull=never --rm --init --cap-drop=ALL --security-opt no-new-privileges --memory=4g --cpus=2
    --pids-limit=512 --shm-size=1g`, and -- **unless `PI_EGRESS=0`** -- `--network=pi-job-<jobId>-net`.
  - **Three of those are NOT members of `ISOLATION_FLAGS`, and this is a list of FLAGS rather than a
    rendering of that constant.** `ISOLATION_FLAGS` (`worker/src/docker-run.mjs`) is the **literal,
    value-free, unconditional** set, and two places assert every member of it reaches the sandbox argv
    *against the imported array, not a copy* (`CONST-ISOLATION-CONTAINER-PER-JOB`, `INT-SANDBOX-CONTRACT`).
    `--memory`, `--cpus` and `--network` carry **configured values** and are appended beside it. The
    distinction is load-bearing rather than clerical: a conditional flag inside that array makes "every
    member" false on any deployment running without an egress policy, so the assertion would have to be
    weakened to "every member except this one" -- which does not weaken a constraint so much as **retire
    the assertion that was enforcing it**.
  - **Mounts**: `/job:ro`, `/workspace:rw`, `/outbox:rw` (local jobs only), `/opt/pi-global:ro` (when
    configured), and `/session:rw` — the last only when a trigger armed `run.resume` and the worker
    resolved a key (`INT-SESSION-STORE-CONTRACT`). `/session` is a **per-job** directory under the job's
    own dir; the shared store is never bind-mounted into anything.
  - **A conformance item, and it belongs on the "fails silently or late" list above**: an image must
    declare its pi version as the `dev.pi-dispatch.pi-version` LABEL and its runner must honour
    `PI_SESSION_FILE`. An image that declares no version never resumes, which is the safe direction; one
    whose runner ignores the variable produces jobs that never resume and never say so, which is not.
  - **A second labelled conformance item, and its polarity is the OPPOSITE of `dev.pi-dispatch.forges`.**
    An image that can serve replica jobs (`REQ-REPLICA-RUNS`) must say so in a
    `dev.pi-dispatch.capabilities` LABEL naming `replicas`, and its baked `HARD_RULES.md` rule 3 must name
    *the branch your prompt names, always under `pi/issue-*`* rather than hard-coding `pi/issue-<n>`. The
    two go together and neither is decorative: a replica's **user** prompt names `pi/issue-<n>-r2` while a
    pre-feature safety floor names `pi/issue-<n>` as a **system** rule, which the model treats as
    authoritative — so both replicas would converge on one branch. Nothing errors; the operator pays for
    two runs and gets one pull request, which is precisely the "silent or late" class this list exists for.
    Hence the polarity: `forges` is an **exclusion** list, so declaring nothing excludes nothing and an
    unlabelled image is admitted for every forge; `capabilities` is an **inclusion** list, so declaring
    nothing includes nothing and an unlabelled image is **refused** every replica job, pre-spend, with
    reason `job-image-replicas-unsupported`. One rule underlies both — an image that declares nothing gets
    no benefit of the doubt about what it contains — and neither costs an unflagged job anything.
    `verify-image.sh` greps the baked guardrails when the label claims `replicas`, so this label cannot lie
    any more than `forges` can.
  - User: non-root
  - **`--pull=never`.** `docker run` defaults to `--pull=missing`, which makes an unrecognised image name a
    **registry fetch**: a typo in the operator's image config would pull and execute a stranger's image under
    a name that looks like theirs. `never` makes that branch **unreachable rather than merely unlikely** --
    the same move `PI_OFFLINE=1` makes one layer up (pi's job-time `npm install`), for the same reason and
    with the same shape: a narrowing the whole fleet gets, not a per-job capability. Every other flag in this
    list bounds what a chosen image may **do**; this one bounds **which image is chosen at all**, which is
    why it leads. It costs nothing the documented flow was using: the install step in `README.md` is an
    explicit `docker pull && docker tag`, `pi-job:latest` is a local-only tag with no registry behind it, and
    `pi-dispatch doctor` already checks presence. The affected case is an operator who set `PI_JOB_IMAGE` to
    a registry ref and relied on the first job pulling it; they now get a **pre-spend refusal naming the
    image** instead of a multi-minute pull inside a container whose 30-minute kill timer is already running,
    charged to a budget slot. That readable refusal is the **preflight's** job -- a `docker image inspect`
    before `reserveBudget` (`worker/src/image-preflight.mjs`), returning `policy` with reason
    `job-image-missing` rather than throwing, because retrying never makes a misspelled tag appear
    (`CONST-RETRY-INFRA-ONLY`). The two are not redundant: the check is readable but raceable, the flag is
    unraceable but silent.
  - **`--network=pi-job-<jobId>-net`, present unless `PI_EGRESS=0`, and its OWN network per job.**
    `docker run` defaults to the shared bridge, which is not a neutral starting point but a policy: the
    whole internet, in front of a container holding a provider key and a minted forge token, reading text
    anyone could have written. This flag is how an egress policy becomes a property of the **argv** rather
    than of a host firewall the worker cannot see, report or check -- the same move `--pull=never` makes for
    image selection and `PI_OFFLINE=1` makes for pi's resolver.
    **Per job, and that is the clause with a measurement behind it.** One shared network would be one shared
    L2 segment, and at `DES-CONCURRENCY-3` that is three mutually-untrusting issue authors who can reach
    each other. `com.docker.network.bridge.enable_icc=false` is the obvious fix and it is not one: ICC
    governs **every** container pair on the bridge and the proxy is a container, so it blocks job-to-proxy
    along with job-to-job (verified in both directions against a control network). A network per job makes
    job-to-job **structurally impossible** instead, which is strictly stronger than what preceded it -- two
    job containers on the default bridge can reach each other by IP today, so this **removes** an adjacency
    rather than adding one. Measured cost: ~190ms to create and attach, ~260ms to detach and remove.
    **The proxy carries EVERYTHING, including the provider call, and there is no address-based rule
    anywhere.** The container env gains `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` **and `NODE_USE_ENV_PROXY=1`**,
    all four in the closed map (never `PI_FORWARD_ENV`, which refuses those names at boot while the policy
    is armed). The fourth is the one that matters: without it the other three steer `git`, `gh`, `npm` and
    Chromium but not the runner's own provider call, because the Anthropic SDK resolves `globalThis.fetch`
    at construction and pi passes it no dispatcher. Behind an internal network that is not a leak but an
    **outage** -- every job dies at its first turn. `docs/sandbox.md` recorded the opposite (that pi's
    client cannot be steered by any environment variable, so the provider needs a network-layer rule); that
    is **refuted** and the correction is in `docs/egress.md`, with the measurement: the same SDK client, in
    the pinned image, follows a dead proxy to `ECONNREFUSED` with the flag and goes straight to DNS without
    it. The original observation was a variable that never reached the container.
    **`PI_EGRESS=0` is not a degraded mode, it is the prior behaviour byte for byte**: no `--network`, no
    proxy variable, no preflight spawn, and an argv identical to one built before this contract named a
    network. It is an opt-OUT rather than an opt-in because a control that ships off is a control nobody
    enabled, which is the state `OQ-004` spent a year in.
  - **A conformance item for the policy, and it belongs on the "fails silently or late" list above**: the
    proxy component must be running unless `PI_EGRESS=0`. Unchecked it fails **late and expensively** -- the
    container starts, the provider is unreachable, the runner exits `1`, which is the RETRYABLE class, so
    `attempts: 2` runs it again and `releaseBudget` refunds neither (only `container-never-started` is
    refunded, and this container started). Two job-count slots per job, buying nothing. Hence a pre-spend
    refusal (`REQ-EGRESS-ALLOWLIST`), which pairs with the flag exactly as the image inspect pairs with
    `--pull=never`: the check is readable but raceable, the flag is unraceable but silent, and neither is
    sufficient alone.
  - **`--shm-size=1g`, and explicitly NOT `--ipc=host`.** Playwright's docs say verbatim: *"Using
    `--ipc=host` is recommended when using Chromium. Without it, Chromium can run out of memory and
    crash."* **We deliberately diverge.** `--ipc=host` shares the **host's IPC namespace** with a
    container running adversarial-input agent code — it trades a documented crash for an undocumented
    hole in `CONST-ISOLATION-CONTAINER-PER-JOB`. Playwright's docs assume a *trusted* CI container; ours
    is hostile by design. The crash is caused by Docker's default 64 MB `/dev/shm`, so `--shm-size`
    fixes the actual cause without touching namespacing. If Chromium still OOMs, **raise `--shm-size`;
    never reach for `--ipc=host`.**
  - **`--init`.** Playwright: *"recommended to avoid special treatment for processes with PID=1. This is
    a common reason for zombie processes."* Our entrypoint `exec`s the runner, so **node is PID 1** and
    reaps nothing. Chromium spawns many processes; zombies accumulate against `--pids-limit` until the
    job dies of something unrelated to its actual work.
  - Env **passed by the worker**: any variable a trigger's `run.secrets` names, resolved HOST-SIDE before the
  container starts and injected exactly as the provider credential is (`REQ-TRIGGER-SECRETS`) -- a value, never
  the manager credential that fetched it, and assigned AFTER `PI_FORWARD_ENV` but BEFORE the egress policy's
  variables and the minted token, so a trigger can outrank the operator's blanket host list and can outrank
  neither the network policy nor the per-job credential; the configured provider's key variable(s), derived — not hardcoded
    (see below); the minted per-job token under **its own forge's variable
    names, and only those**: `GITHUB_TOKEN` + `GH_TOKEN` for a github job (and for a local cron job that
    opts in via `run.github: true`, `INT-TRIGGERS-FILE-CONTRACT`); `GITLAB_TOKEN` + `GL_TOKEN`, plus
    `GITLAB_HOST`, for a gitlab job. Each forge's pair is mirrored because its CLI has its own preference
    (gh prefers `GH_TOKEN`, glab prefers `GITLAB_TOKEN`), which forecloses precedence surprises.
    **Cross-forge export is refused by construction**: a GitLab credential exported as `GITHUB_TOKEN`
    would be sent by `gh` to github.com on the agent's first invocation — a working credential handed to
    the wrong host, which is precisely how a scoped token stops being scoped. Absent otherwise; `PI_JOB_ID`; `PI_PROVIDER`;
    `PI_MODEL`; `PI_MAX_TURNS`; `PI_MAX_TOKENS` (the per-job token budget — forwarded ONLY when set, omitted
    otherwise so the runner meters usage without a cap; `REQ-TOKEN-ACCOUNTING-AND-CAPS`); `PI_CODING_AGENT_DIR`
    (if not `$HOME/.pi/agent`); `PI_GLOBAL_ALLOW_EXTENSIONS=0` (forwarded ONLY to carry the operator's explicit
    opt-OUT — loading is the **absence** of the variable, on both sides of the mount, so an unset var and an
    explicit `true` emit nothing at all; `REQ-GLOBAL-PI-OVERLAY`); `PI_PACKAGES` (the `":"`-delimited ABSOLUTE
    CONTAINER paths of the operator-staged pi packages, forwarded whenever at least one package is staged
    **and** the trigger did not withhold them with `run.packages: false`, and **omitted entirely**
    when empty, never an empty string. The delimiter is `":"` because these are CONTAINER paths; the host's
    `path.delimiter` is `";"` on Windows and would be wrong); `PI_FLOW` (the trigger's `run.flow`, verbatim —
    forwarded ONLY when the job carries a flow, omitted for a bare `run.task` cron job, never an empty
    string. The flow already reaches the model as prompt prose; this variable is its **structural** copy, so
    the runner can compare the name against the skill set that actually loaded and report a flow that
    resolved in no tier (`flow_not_loaded`, one line, flow name and a count, never task content) instead of
    running to a clean exit 0 without the procedure the trigger named. It rides env and **not** `event.json`
    because an execution knob is not a fact about the delivery — the same line `run.replicas` draws. The
    runner takes **no charset opinion** on the value: it is compared and logged, never interpolated into a
    path, and a runner stricter than the worker's own validator would start failing yesterday's jobs on an
    image upgrade); `PI_COMMAND` (a `run.command` trigger's command line, without its leading slash —
    forwarded ONLY for command jobs, omitted otherwise, never an empty string. The runner rebuilds the
    prompt as `/<value>` from THIS variable rather than reading `prompt.md`, so the container has one
    authority for what dispatches; `prompt.md` carries the same bytes as the human record. The runner
    validates it strictly — no leading slash, no surrounding whitespace, no control characters — because
    pi's dispatch grammar reads the name to the first space and passes everything after verbatim as
    handler args, so a malformed value would silently change what runs rather than fail. Verification,
    dispatch and classification are `INT-RUNNER-EXIT-CODE-PROTOCOL`'s command rows); and each name in `PI_FORWARD_ENV` (an explicit operator
    allowlist of extra host vars — e.g. a custom provider's key — forwarded by exact `-e NAME=VALUE`, never a
    pass-through, so it satisfies `no-broad-env-into-container`; **every** minted-token name is refused in
    the allowlist at config load — derived from the forge table rather than enumerated here, currently
    `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `FORGEJO_TOKEN`, `GITEA_SERVER_TOKEN`,
    `AZURE_DEVOPS_EXT_PAT`, `SYSTEM_ACCESSTOKEN` — because a forwarded operator token would silently
    override the minted per-job value. The list grows with each forge, which is why it is a set rather
    than a pair. **`GITHUB_APP_PRIVATE_KEY` is refused for a second, different reason**: nothing overrides
    it, it simply does not belong in a container. It is the App's *signing* key, so it mints installation
    tokens for every repository the App is installed on — strictly broader than the per-job token
    `CONST-TOKEN-SCOPED-PER-JOB` bounds, and handed to a process reading adversarial issue text. The
    matching `GITHUB_APP_PRIVATE_KEY_PATH` is deliberately NOT refused: a path with no mount behind it is
    inert in a container, and a refusal that fires on harmless things stops being read). Note `PI_DAILY_TOKEN_CAP` is **worker-only and is
    NOT forwarded** — the daily token counter is enforced host-side, and the container stays queue/budget-blind.
  - **`PI_OFFLINE=1` is set UNCONDITIONALLY, on every job — the one env addition here that is not opt-in.**
    Every other variable above is forwarded only when something armed it; this one is not, and the reason is
    that it is a **narrowing, never a capability**. pi's package resolver shells out to a real `npm install`
    for any `npm:`/`git:` source unless offline mode is on, and `~/.pi/agent` **is** writable in the
    container — so an unresolved source would become a live network install of third-party code, at agent
    runtime, from inside a container whose own input can influence what is requested. The worker emits only
    local paths, so nothing should reach that branch; setting the flag makes it **unreachable** rather than
    merely unused. Gating it on the packages opt-in would leave the branch armed for every job that did
    **not** opt in, which is exactly backwards. The runner re-asserts it in-process for the same reason
    (`INT-SDK-SESSION-OPTIONS`): offline is a property of the runner, not of whoever started it, so a
    hand-run `docker run` or a future worker regression cannot re-arm the install path.
    **The `--network` flag is deliberately NOT this shape, and the analogy is the first thing a reader will
    reach for.** `PI_OFFLINE=1` can be unconditional because it costs an unarmed job **nothing**: the branch
    it forecloses is one nothing should reach anyway. A network flag cannot be, because a deployment that
    has not started the proxy would have every job fail at `docker run` -- which is not a narrowing, it is
    an outage. So the policy is armed by configuration and the *narrowing discipline* moves one level down:
    given a policy, the flag is on **every** job with no per-trigger opt-out. Note also what an allowlist
    does not re-arm: `registry.npmjs.org` being reachable from the container does not put pi's resolver back
    on the network, because offline is a property of the **runner**, re-asserted in-process.
  - **Per-job token *scoping* (`CONST-TOKEN-SCOPED-PER-JOB`) is the App path's property, not `gh`'s.** With
    `GITHUB_AUTH_SOURCE=gh` (the default) the minted value is the operator's own full-scope `gh auth token`,
    so every token-carrying job holds whatever that login can do; a fine-grained PAT approximates per-job
    scoping for a single owner, and only the App path delivers it. `doctor` warns and names the actual
    scopes. Either way the credential reaches the container only as env values — the operator's
    `~/.config/gh` is never mounted.
  - Env **baked into the image**, because they are facts about the image and not choices a job makes:
    `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `PLAYWRIGHT_MCP_BROWSER=chromium`,
    `PLAYWRIGHT_MCP_SANDBOX=false`. **`PLAYWRIGHT_MCP_BROWSER` is load-bearing**: `playwright-cli`
    defaults to the branded **`chrome` channel** and looks for `/opt/google/chrome/chrome`, which this
    image does not have and must not — a system Chrome with a persistent profile is exactly what
    `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS` rejected. Omit it and every frontend job dies with
    *"Chromium distribution 'chrome' is not found"*, making `REQ-FRONTEND-VISUAL-VERIFY` dead on
    arrival. Leaving these to the worker means every caller must remember them; baking them means the
    image cannot be held wrong.
  - **The provider key variable is derived from pi's own table via `findEnvKeys(provider)`**
    (`import { findEnvKeys } from "@earendil-works/pi-ai/compat"`), never hardcoded and never
    pass-through. pi supports ~30 providers, each with its own variable, so "support any model" must not
    become "forward everything" — `no-broad-env-into-container` is a BLOCKER. Deriving the allowlist
    from pi's table rather than copying it means it **cannot drift** when pi adds a provider, and a
    hand-maintained copy is exactly the reinvention `no-reimplementing-pi` forbids. For `anthropic` the
    call returns `["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]` — **the array order *is* the
    precedence**, which is precisely the trap this rule exists for.
  - **Sourcing the key from pi's `auth.json` is a credential *source*, not a new injection path, and is ON by
    default.** When the provider key is absent from the worker env, the worker reads it **host-side** from
    `~/.pi/agent/auth.json` (honoring `PI_CODING_AGENT_DIR`) and injects it under the variable name pi expects
    — the name resolved by the same `findEnvKeys` oracle, so no hand table. It stays a HOST-SIDE read of a
    host-held secret, env-injected exactly like the env path, **never a credential file mounted into the
    container** (`CONST-TOKEN-SCOPED-PER-JOB`). **API-key credentials only**: an OAuth/subscription login is
    refused pre-spend (it expires, the container cannot refresh it, and it is not the credential for an
    unattended service). The env, when present, always wins — this is a fallback, not an override.
    `PI_AUTH_FROM_PI=0` disables it (env-only, fail-loud on a missing env key).
  - Mounts: `/job:ro`, `/workspace:rw`, — **local jobs only** — `/outbox:rw`, and — **only when
    `PI_GLOBAL_PI_DIR` is configured** — `/opt/pi-global:ro` — delivered by host bind mounts
    (`-v <hostPath>:<containerPath>`, per `DES-WORKER-ON-HOST` and `worker/src/docker-run.mjs`): the worker
    runs on the host and binds the per-job inputs dir, the workspace folder, the outbox dir, and the operator's
    global pi overlay directly. `/opt/pi-global` is the operator's own `~/.pi/agent` subset — custom models, global
    skills, a global persona, and (fourth) the **staged pi packages** under `packages/<dir>/`, which ride this same
    mount rather than adding one: **the mount list itself is unchanged**, which is what keeps
    `CONST-ISOLATION-CONTAINER-PER-JOB`'s enumerated acceptance untouched — layered UNDER each repo's `.pi/`
    (`REQ-GLOBAL-PI-OVERLAY`, `DES-OPERATOR-GLOBAL-OVERLAY`);
    it is `:ro` and **credential-free by construction** (`import-pi` refuses a literal-key `models.json` and never
    copies `auth.json`; `CONST-TOKEN-SCOPED-PER-JOB`). No credential is ever written to `/outbox` or `/opt/pi-global`
    (same rule as `/workspace`).
  - No TTY (`-it` absent)
  - **The agent dir must be writable by the non-root runtime user.** pi lazily creates
    `~/.pi/agent/` (mode `0700`) and `auth.json` (mode `0600`, contents `{}`) on the **first credential
    operation** — both `withLock` and `withLockAsync` call `ensureParentDir()` + `ensureFileExists()`.
    Bake the guardrails in as root and forget to `chown`, and the job dies EACCES at runtime, inside the
    container, on a path nothing in the Dockerfile hints at. `models.json` is the exception: read-only,
    never created, safe if absent.
    **Inversely, the guardrails, the runner, `node_modules`, and the browser cache are root-owned and NOT
    writable by the runtime user.** The agent runs *as* that user; if it could rewrite
    `/opt/pi-dispatch/HARD_RULES.md` it would own its own safety floor, and `/job:ro` — which exists
    precisely so the agent cannot rewrite its instructions — would be pointless next to a writable `/opt`.
    Only `~/.pi/agent` is agent-writable, because pi must write `auth.json` there. Everything the agent
    merely reads or executes stays root-owned; the browser binaries are `0755` root-owned, which is all a
    non-root user needs to launch Chromium.
    **`COPY --chown` alone does NOT fix this** — it does not apply to parent directories that `COPY`
    auto-creates, so `/home/pi/.pi` and `/home/pi/.pi/agent` are still born `root:root`. The trap
    survives the obvious fix. Create and chown the directory explicitly:
    ```dockerfile
    RUN mkdir -p /home/pi/.pi/agent && chown -R pi:pi /home/pi/.pi
    COPY --chown=pi:pi guardrails/HARD_RULES.md /home/pi/.pi/agent/APPEND_SYSTEM.md
    ```
  - **Chromium's own sandbox is disabled via `PLAYWRIGHT_MCP_SANDBOX=false`** — an env var, **not** a
    `--no-sandbox` argument, and not a `playwright-cli` flag. This is a **deliberate divergence from
    Playwright's docs**, which never mention disabling it: their supported path for non-root Chromium is
    a custom seccomp profile granting `clone`/`setns`/`unshare`, or `--cap-add=SYS_ADMIN`. We give it
    neither, because `--cap-drop=ALL` *is* `CONST-ISOLATION-CONTAINER-PER-JOB`'s enforcement surface.
    Disabling the inner sandbox does not acquire the privilege — it skips the code path that needs it,
    leaving the container as the only boundary, which is what this project already decided the boundary
    is. **Never "fix" a Chromium launch error by adding `SYS_ADMIN` or widening seccomp**: that trades
    the outer boundary for an inner one against adversarial input, inverting the security model. Written
    here because the vendor's own documentation recommends the thing we must not do.
  - **`playwright-cli` is stateful.** `open <url>` starts a session; `screenshot --filename <path>` acts
    on the current page; `snapshot` returns the DOM. There is no one-shot `screenshot <url> <path>` form.
    **Navigation to `file://` is blocked outright** by default (not merely restricted to cwd — an
    earlier version of this spec claimed the latter, and it was wrong). A frontend job navigates its dev
    server over **http**, which is not blocked; that is the real usage and the only one worth testing.
    Do **not** set `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS` to work around the block — the block
    is a good default.
  - **Fonts are required, and their absence is silent.** `bookworm-slim` ships none, so Chromium renders
    tofu boxes and screenshots look plausible while containing no legible text — which would quietly
    gut `REQ-FRONTEND-VISUAL-VERIFY`, the capability the whole image exists for. Install `fontconfig` +
    `fonts-liberation` + `fonts-dejavu-core` and run `fc-cache -f`.
- **Why**: This is the enforcement surface of `CONST-ISOLATION-CONTAINER-PER-JOB` — every flag is
  load-bearing and none is decoration. `--cap-drop=ALL` removes the capabilities pi would otherwise
  inherit from the launching user (pi has no permission system of its own to do this).
  `--pids-limit` bounds a fork bomb. `--memory` bounds an OOM to one job rather than the host.
  `PLAYWRIGHT_BROWSERS_PATH` resolves the collision between non-root execution and root-installed
  Chromium — see `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`.
  **Env is an allowlist, never a pass-through**: `ANTHROPIC_OAUTH_TOKEN` silently takes *precedence*
  over `ANTHROPIC_API_KEY`, so a stray variable in the host environment would quietly redirect which
  credential every job spends. Pass exactly these.
  Absence of `-it` is worth knowing rather than relying on: with no TTY, pi enters print mode
  automatically. Pass `-p` explicitly anyway — inferring behaviour from TTY presence is fragile.
- **Open**: `--pids-limit=512` is **UNVERIFIED** — no authoritative figure for headless Chromium exists in
  any vendor documentation. Chromium spawns browser + renderer + GPU + zygote + crashpad per page, plus
  node/pi/git/gh. 512 is a guess wearing a number's clothing, exactly like `OQ-002`'s RAM estimate, and
  it gets measured on the same run rather than trusted. `--init` makes it more survivable by reaping
  zombies that would otherwise accumulate against it.
- **Reference** (no authority): Playwright docs — `--ipc=host` and `--init` recommendations; seccomp /
  `SYS_ADMIN` as the supported non-root sandbox path. Cited to record **what we deliberately do not do**
  and why.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/ai/src/env-api-keys.ts:69-71 → getApiKeyEnvVars`
  — verbatim: `// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY` /
  `return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]` (the array order **is** the precedence) ·
  `→ packages/coding-agent/src/config.ts:515 → getAgentDir()` — `process.env[ENV_AGENT_DIR]` else
  `join(homedir(), CONFIG_DIR_NAME, "agent")`: respects `$HOME`, **no hardcoded `/root`** ·
  `→ packages/coding-agent/src/config.ts:495 → ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\``
  (the override var is *derived*, not a literal — it resolves to `PI_CODING_AGENT_DIR`, and would follow a
  rename of `APP_NAME`) · `→ main.ts:99-108` (no TTY → print mode)
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-TOKEN-SCOPED-PER-JOB`,
  `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`
- **Acceptance**: Chromium launches as the non-root user; `capsh --print` inside the container shows no
  capabilities. **Both hold for every image nameable in `run.image`, not only the one this repo builds** —
  for this repo's image the assertion is the `image` CI job; for an operator-built image it is the
  operator's to run against their own tag (`docs/job-image.md`), and the residual is `OQ-012`. Given a
  `run.image` naming an image absent from the host, `docker run` is never reached: the pre-spend inspect
  refuses first and `--pull=never` forecloses the fetch.

## INT-EGRESS-POLICY-CONTRACT

**worker → docker daemon, and operator → allowlist file.** What the shipped egress policy IS, as objects on
a host, so the worker that builds it, the gate that checks it and the operator who edits it are describing
one thing. A SIBLING of `INT-CONTAINER-RUNTIME-CONTRACT`, on the `INT-SANDBOX-CONTRACT` precedent: that
contract governs the argv of one container, this governs the estate that argv joins.

- **Contract**:
  - **Armed by `PI_EGRESS`, and by nothing else.** Unset, `""` and `"1"` arm it; only `"0"` turns it off;
    **any other value is a boot-time refusal**, never a guess. **The parse lives in one place**
    (`worker/src/egress.mjs`), because the worker reads it through `loadConfig` while `doctor` and `up`
    read the environment directly, and three copies of one default is two chances to flip it in the wrong
    number of places. The strict parse is
    `PI_GLOBAL_ALLOW_EXTENSIONS`' and the reason is sharper here: an operator who believes they have an
    egress policy and does not is in a **worse** position than one who knows they have none, because the
    belief displaces the credential bound that is actually holding.
  - **Objects, and their names are the contract**:

    | Object | Name | Properties |
    |---|---|---|
    | per-job network | `pi-job-<jobId>-net` | `--internal`. Created at job start, removed at job end. Exactly two members: the job container and the proxy. |
    | per-sandbox network | `pi-sandbox-<jobId>-net` | the same, for an operator session (`INT-SANDBOX-CONTRACT`) |
    | upstream network | `pi-dispatch-egress-out` | an ordinary bridge; only the proxy is on it |
    | proxy component | `pi-dispatch-egress-proxy` | squid, `http_port 3128`, **no published port**. Overridable by `PI_EGRESS_PROXY`. |

    The network name is **derived from the container name** (`<name>-net`), never rebuilt from the job id.
    The container name already survives every id shape this project produces and docker's network-name
    grammar is the container-name grammar, so a name legal for one is legal for the other **by
    construction** -- and the `pi-job-`/`pi-sandbox-` namespace split the reaper depends on is inherited for
    free rather than restated.
  - **The allowlist is `egress-allowlist.conf` in the deployment folder**: bare hostnames, one per line,
    `#` comments, a leading dot matching subdomains. Read by squid natively through its quoted-filename ACL
    form, so **no code renders it** and the operator never touches squid syntax. `pi-dispatch init`
    scaffolds it create-only with the provider, the forge and the registry; it is the one scaffold in that
    command that is not empty, because an empty allowlist is not inert -- it is a deployment where every job
    dies at its first turn.
  - **The rules are `deploy/egress-proxy.conf`**, shipped and not edited, mirrored into `worker/deploy/`.
    The split is the security property: `http_access` ordering is what makes an allowlist an allowlist, a
    misordered rule silently allows everything, so the file an operator edits contains no ordering at all.
  - **The proxy image is digest-pinned**, and the `valkey/valkey:8` precedent one service over deliberately
    does not transfer: a floating tag on a queue breaks loudly and spends nothing, while this container **is
    the allowlist**, so a floating tag would let an upstream rebuild change what every job may reach with no
    commit anywhere.
  - **TLS is never terminated.** The proxy sees the name in a `CONNECT` and no byte inside the tunnel, so it
    cannot read a credential and cannot count a token. A proxy that decrypts provider traffic is `OQ-011`'s
    mechanism and is explicitly not this (`OQ-004` warns against conflating them).
  - **What each disagreement fails toward**:

    | State | Result |
    |---|---|
    | `PI_EGRESS=0` | no network, no flag, no proxy variables, **zero docker spawns** -- byte-identical to a deployment before this contract |
    | proxy absent | POLICY refusal `egress-proxy-missing`, pre-spend, not retried |
    | proxy stopped | POLICY refusal `egress-proxy-stopped`, pre-spend, not retried |
    | daemon silent | INFRA `container-never-started`, **retried**, reservation refunded |
    | network create fails | INFRA `container-never-started`, retried; a network the proxy could not join is torn down rather than left half-built |
    | allowlist missing a host | the job runs and the agent is refused by the proxy at that host. **Not** pre-spend detectable, and said so plainly rather than implied away. |
- **Why**: The mechanism was already written down and already run (`docs/sandbox.md`, issue #199). What was
  missing was not the rules but **the worker knowing about them**. Every property this project relies on --
  reporting a refusal an operator can act on, checking a control in `doctor`, refusing before money is spent
  -- requires the policy to be an object the worker names. That is what makes this an argv change rather
  than a documentation change.
- **Traces to**: `REQ-EGRESS-ALLOWLIST`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SANDBOX-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`,
  `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK`, `OQ-004`, `OQ-011`
- **Acceptance**: Given `PI_EGRESS=0`, no docker network is created, no `--network` flag is built, no
  proxy variable is emitted and the preflight spawns nothing. Given any other accepted value and a running
  proxy, each
  job runs on a network whose only other member is that proxy, reaches an allowlisted host, and is refused
  an unlisted one by the proxy rather than by the agent. Given a proxy that is absent or stopped, the job
  returns `outcome: "policy"` with `budgetReserved: false`, `docker run` is never spawned, and the queue
  does not retry it. Given a daemon that does not answer, the job throws and IS retried.

## INT-SANDBOX-CONTRACT

**operator → docker daemon.** A SIBLING of `INT-CONTAINER-RUNTIME-CONTRACT`, never an amendment to it.
That contract governs the container the harness launches against untrusted input and says **"No TTY
(`-it` absent)"**; this one governs a container an operator launches with no agent in it. IDs are
permanent addresses, and the repo has made this call once already — `INT-GITLAB-PAYLOAD-SUBSET` is a
sibling rather than an extension of the GitHub one for the same reason.

- **Contract**:
  - **The argv is built by the SAME builder.** `buildSandboxRunArgs` calls `buildDockerRunArgs` through
    its `extraFlags` seam, so `ISOLATION_FLAGS`, `--memory` and `--cpus` reach this container **by
    construction**: `--pull=never --rm --init --cap-drop=ALL --security-opt no-new-privileges
    --pids-limit=512 --shm-size=1g --memory=4g --cpus=2`. This is the load-bearing sentence of the whole
    contract. A leaner hand-written argv here would be a second place for the boundary to live, and the
    copy that did not get the next flag would be the one nobody was looking at.
  - **Adds exactly**: `-i -t --entrypoint bash`, and `-p 127.0.0.1:<host>:<container>` per `--publish`.
  - **Mounts**: the retained per-job directory at `/job:ro` and its workspace at `/workspace:rw` — the
    same two the run itself had, from the same paths. **No `/outbox`** (nothing to chain: no agent),
    **no `/session`** (the transcript is deleted before retention), **no `/opt/pi-global`** (pi is not
    running).
  - **A sandbox joins the job's kind of network**, through the same builder seam that already delivers
    `ISOLATION_FLAGS`, `--memory` and `--cpus`, so it is inherited by construction rather than by a promise.
    Its own network, named off its own container (`pi-sandbox-<jobId>-net`), which keeps it outside the boot
    reaper's `pi-job-` filter for the reason the container names already are: a worker restart must not tear
    the network out from under a shell an operator is sitting in. Rejected: leaving sandboxes on the open
    bridge, which reads as a convenience and is a **wider reach than the run the sandbox exists to
    reproduce** -- a shell that can go where the run could not is not reproducing it. The **preflight does
    not gate a sandbox**: that is a money gate and a sandbox spends nothing, so a missing proxy fails at
    `docker run` with docker's own message, in front of an operator at a terminal, which is the one place a
    late failure is cheap.
  - **Env is exactly `TERM` and `TMOUT`**, plus the three proxy variables when a policy is armed. No minted forge token under any forge's variable names, no
    provider key, no `PI_FORWARD_ENV` pass-through, none of the `PI_*` job variables. `buildContainerEnv`
    is NOT reused and cannot be: it writes the mint (`env-allowlist.mjs`) and throws when no provider
    credential resolves, so it has no credential-free output to produce.
  - **Name**: `pi-sandbox-<sanitizeJobId(jobId)>`. Docker matches `--filter name=` as a **substring**, and
    the boot reaper filters `name=pi-job-`; `pi-sandbox-` shares no substring with it, which is the whole
    reason a worker restart cannot `docker rm -f` a shell an operator is sitting in.
  - **Retained directory layout**, under `PI_SANDBOX_DIR` (default `<PI_JOBS_DIR>/sandboxes`, mode `0700`):
    ```
    <sandboxDir>/<sanitizeJobId(jobId)>/
      manifest.json          mode 0600
      prompt.md  event.json  pi/     the run's /job inputs, mounted :ro
      workspace/                     forge jobs only; a local job's workspace is the operator's folder
    ```
    ```jsonc
    { "jobId": "gh-12345", "kind": "github", "image": "pi-job:latest",
      "workspace": "/abs/host/path", "createdAt": "2026-08-01T10:00:00.000Z", "keepUntil": null }
    ```
    `image` is resolved through `resolveJobImage` — the same function the pre-spend preflight and
    `run-container.mjs` use — so the tag that was checked, the tag that ran and the tag re-opened are one
    answer rather than three call sites that agree by luck. `workspace` is rebased onto the retained
    directory when the run's workspace lived inside it, and recorded verbatim when it did not; decided by
    path containment, never by `kind`, so a preparer that moves its clone cannot record a path that does
    not exist.
  - **NOT the run-history record.** `INT-RUN-HISTORY-FILE-CONTRACT` is PII-free by construction, and that
    property is what lets the admin extension feed those records to a model. This manifest holds a host
    path — which on Windows embeds the operator's account name — so it is a separate file that never goes
    near a prompt. The panel renders the retention *verdict*, never the path.
  - **Retention**: `createdAt + PI_SANDBOX_RETENTION_HOURS`, or `keepUntil` when pinned. Swept at worker
    boot. `0` = OFF: nothing retained, and the sweep's cutoff becomes `now`, so it also clears what an
    earlier setting kept. There is no keep-forever value.
  - **Age comes from `createdAt`, never mtime.** `makeLogReaper` calls mtime "the authority" and is right
    about an append-once log file. An operator working inside a resurrected sandbox writes into the
    directory, so mtime would keep moving and the window would never close — for exactly the directories
    most likely to be large.
  - **The sweep asks docker first.** `listRunningSandboxes` yields the job ids of live sandboxes and
    **throws** when docker cannot be reached, because "none are running" and "I could not find out" must
    not arrive as the same empty array in front of a `rm -rf`. A failed lookup skips the whole sweep.
- **Why**: The 5% case (`REQ-RESURRECTABLE-SANDBOX`). Every choice above exists to keep the *job*
  contract untouched while serving it: a second container shape rather than a longer-lived first one, a
  second env builder rather than a credential-optional one, a second name namespace rather than a
  reaper exemption, and a second reaper rather than a widened log sweep.
- **Traces to**: `REQ-RESURRECTABLE-SANDBOX`, `CONST-ISOLATION-CONTAINER-PER-JOB`,
  `CONST-TOKEN-SCOPED-PER-JOB`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SESSION-STORE-CONTRACT`,
  `DES-SANDBOX-IS-A-FRESH-CONTAINER`
- **Acceptance**: The sandbox argv contains every member of `ISOLATION_FLAGS` (asserted against the
  imported array, not a copy), contains `-i`, `-t` and `--entrypoint bash`, ends with the image, and
  contains no member of `MINTED_TOKEN_VARS` and no provider key variable. The container name contains no
  `pi-job-`. `--publish 3000` yields `127.0.0.1:3000:3000` and an explicit bind address is refused. A
  retained directory contains no `session/`. A directory whose sandbox is running is not swept, and a
  sweep whose docker lookup failed removes nothing. Unless `PI_EGRESS=0` the argv carries
  `--network=pi-sandbox-<jobId>-net` and the three proxy variables, and **still no credential** -- a proxy
  URL is not one, and `buildContainerEnv` is still not reused here. Given `PI_EGRESS=0`, the argv is
  byte-identical to one built before `REQ-EGRESS-ALLOWLIST` existed.

## INT-WEBHOOK-PAYLOAD-SUBSET

**GitHub → receiver.** *(GitLab's is a separate contract — `INT-GITLAB-PAYLOAD-SUBSET`. This ID keeps
its name and its GitHub-only body: IDs are permanent addresses, and a second forge's payload is a
different shape rather than an extension of this one.)*

- **Contract**:
  - Events consumed: `issues`, `issue_comment`, `pull_request`, `pull_request_review`. Everything else
    drops as `unhandled-event`.
  - **The `closed` action is consumed on `issues` and on `pull_request`** (issue #231), routed to the
    close rules (`INT-TRIGGERS-FILE-CONTRACT`'s `issue` type and close-only `pull_request` rules) and
    gated on the CLOSER per `CONST-TRIGGER-AUTHOR-GATE`'s close arm. A merged PR's delivery carries
    `action: closed` too, so a close rule fires on merge-closes and plain closes alike — stated so
    nobody reads the `merge` word's absence from the trigger vocabulary as merge-closes not firing.
  - **`pull_request_review` is a second event name on ONE trigger type** (issue #66). Its `submitted`
    action routes exactly as a `pull_request` action does, under the trigger word `review_submitted`
    (`INT-TRIGGERS-FILE-CONTRACT`); `edited` and `dismissed` drop as `unhandled-event`, because an edit
    would re-fire on text already paid for and a dismissal withdraws a verdict rather than stating one.
  - Headers consumed: `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`
  - Body fields consumed: `action`, `issue.number`, `issue.title`, `issue.body`, `issue.labels[].name`,
    `issue.pull_request` (presence marker only — an `issue_comment` on a PR carries it), `comment.body`,
    `comment.author_association`, `sender.id`, **`sender.login`** (issue #231 — carried for EXACTLY ONE
    consumer, the closer-permission lookup on close routes; never logged, never enqueued: the job's
    `trigger.sender` stays `{ id }`, the forgejo subset's own justification for its `login` applied
    here), `repository.full_name`, and for a `pull_request` event:
    `pull_request.number`, `pull_request.title`, `pull_request.body`, `pull_request.author_association`,
    `pull_request.labels[].name`, `pull_request.head.ref`, `pull_request.head.sha`,
    `pull_request.head.repo.full_name`, `pull_request.base.ref`; and for a `pull_request_review` event
    those same `pull_request.*` fields (the payload carries the full PR object) **plus** `review.id`,
    `review.body`, `review.state`, `review.author_association`.
  - **`review.state` is folded to lower case on projection**, and that fold is normative rather than
    cosmetic. GitHub spells it `approved` on the webhook and `APPROVED` on
    `GET /repos/{o}/{r}/pulls/{n}/reviews`, so without the fold the identical review would produce two
    different jobs depending on transport, and a polled `COMMENTED` would slip past the empty-body refusal
    below. `review.user` is deliberately **not** consumed: `sender.id` is the only identity the gate and
    the bot-loop guard read, and a login is PII with no reader.
  - **`review.id` is consumed because the receiver cannot see a review's inline comments.** Those ride
    `pull_request_review_comment`, an event this contract does not consume, so a flow that wants them has
    the id and nothing else. Note the consequence, which is stated plainly rather than buried: a
    Comment-type review made ONLY of line comments arrives with an empty body and is refused below, so the
    id serves the `approved` and `changes_requested` reviews that carry inline comments and do fire.
  - **An empty-bodied `commented` review is refused** under its own reason, `no-review-body`, rather than
    starting a run on an empty string. `approved` and `changes_requested` still fire with no body: there
    the verdict is itself the signal.
  - `issue.labels[].name` and `pull_request.labels[].name` are consumed as a **set**, evaluated by the
    `{any, all, none}` trigger predicate (`REQ-TRIGGER-AUTHOR-GATE`) — this changes *how* the field is
    used, not which fields are read.
  - For a comment-triggered job, `comment.body` and `comment.author_association` now ride the job as
    `trigger.comment` into `/job/event.json` and the prompt's fenced data region
    (`INT-CONTAINER-JOB-INPUTS`) — the first time these two fields leave the receiver. The subset itself is
    unchanged — both were already named here — and the body stays data-by-placement
    (`CONST-ISSUE-TEXT-IS-DATA`).
  - For a review-triggered job, all four `review.*` fields ride the job as `trigger.review` into
    `/job/event.json`, and `review.body` **alone** enters the prompt's fenced data region — `state`, `id`
    and `author_association` are metadata and stay in `event.json`, the same line `comment.author_association`
    has always been on. The body is data-by-placement (`CONST-ISSUE-TEXT-IS-DATA`); it is untrusted text
    from whoever cleared the gate, and it is the whole point of carrying the review at all, since a
    "Request changes: rename the helper" review that starts a job the agent cannot read is a half fix.
  - **`pull_request.head.*` and `.base.*` are DATA only.** They are attacker-controlled (the head may be a
    fork) and are carried into `/job/event.json` for the flow's own `gh` use; they are **never** used as a
    clone ref. The worker still clones the base repo's default-branch SHA (`INT-CONTAINER-JOB-INPUTS`).
  - **Everything else is ignored.**
  - **The subset may be SYNTHESIZED from REST objects** (issue #81): the polling producer
    (`pi-dispatch-receiver poll`, `DES-GH-POLLING-TRANSPORT`) builds these exact shapes from
    `GET /repos/{o}/{r}/issues/events`, `/issues/comments`, `/pulls`, and `/pulls/{n}/reviews` responses
    instead of webhook
    deliveries, and feeds them through the SAME pure `filter()` — the parity is pinned by tests that
    run both forms through the gate and assert identical verdicts and enqueue payloads. Delivery ids
    become `poll-e<event>`/`poll-c<comment>`/`poll-pr<n>-<sha7>`/`poll-rv<review>`, disjoint from webhook
    GUIDs inside
    the same `gh-` dedup space. The reviews source (issue #66) sweeps only OPEN pull requests, so a review
    on a closed one is never synthesized — the call `merge` still gets in the action vocabulary, and the
    call `close` got until #231 made it a gated action of its own —
    and it exists at all because the alternative was a `review_submitted` trigger that loads clean under
    polling and can never fire, the silently dead trigger `INT-TRIGGERS-FILE-CONTRACT` refuses at load.
    **The `closed` source (issue #231) reads the SAME `/issues/events` feed the labeled source reads**:
    a `closed` entry's `actor` IS the closer and carries `{ id, login }` (verified against the live
    API), pull requests appear in that feed too (discriminated by `issue.pull_request`, exactly as the
    labeled source discriminates — and a MERGED PR emits `closed` there, so merge-closes fire under
    polling as they do under webhooks), and the PR arm fetches the PR object once so the synthesized
    subset matches the webhook shape; the parity pin extends to closes. Delivery ids stay in the
    `poll-e<event>` family. The one deliberately-guarded source: nothing is synthesized from the
    open-PR-list DISAPPEARANCE the pulls source tracks, because that list cannot name the closer and a
    close that cannot be gated must not exist. The closer gate runs in the poller's own choke point
    with the same one-derivation predicate the webhook arm uses; an INDETERMINATE lookup retries the
    exact event next cycle — the events cursor holds, and ONLY the events feed ends for that cycle
    (a monotone cursor cannot skip an entry, but the comment and pull feeds run on their own cursors
    and must not starve behind a close-gate spell) — bounded, then that one close drops LOUDLY
    (`poll_close_gate_gave_up`) rather than wedging every later event forever, the availability half
    of fail-closed this transport must keep because nothing redelivers to a poller.
    The headers row above does not apply to synthesized subsets — there is
    no HMAC because there is no inbound delivery to authenticate; TLS + the operator's own credential
    against api.github.com is the transport trust (`SECURITY.md`).
- **Why**: Naming the subset **is** the contract. Because everything else is ignored by construction, an
  upstream schema addition cannot change our behaviour — and a reviewer can see the entire attack
  surface as one list, instead of inferring it from destructuring scattered across a handler. Every
  field here is attacker-controlled except the headers and `sender.id`, and the headers are only
  trustworthy *after* `CONST-HMAC-OVER-RAW-BODY` has run. `pull_request.author_association` is
  attacker-*claimed* but GitHub-*computed*, and it gates the auto actions — a stranger cannot forge
  themselves into `COLLABORATOR` because GitHub, not the payload author, sets it.
  `review.author_association` is the same class of field and carries the same argument, but it is a
  **different field gating a different arm**, and the distinction is the reason this entry names both:
  on an auto action the say-so being taken is the PR author's, on a review it is the reviewer's, because
  a review is the first GitHub event where those are different people
  (`CONST-TRIGGER-AUTHOR-GATE`). Reading `pull_request.author_association` for a review would refuse a
  collaborator's review of a stranger's fork PR and accept a stranger's review of their own — wrong in
  both directions at once, which is why the subset names the reviewer's field explicitly rather than
  letting a reader infer it from the PR one sitting next to it.
- **Traces to**: `CONST-HMAC-OVER-RAW-BODY`, `REQ-TRIGGER-AUTHOR-GATE`, `REQ-DEDUP-BY-DELIVERY-GUID`,
  `INT-CONTAINER-JOB-INPUTS`
- **Acceptance**: Given a payload with unknown extra fields, behaviour is unchanged. Given a
  `pull_request` payload, no `head.sha`/`head.ref` value is ever passed to a clone or fetch — the fetch
  pins the base default-branch SHA. Given a `pull_request_review.submitted` whose `review.author_association`
  is `COLLABORATOR` and whose `pull_request.author_association` is `NONE`, the subset carries both and the
  gate reads the review's; given the mirror (`review` `NONE`, `pull_request` `OWNER`) it reads the review's
  again and refuses. Given a REST review whose `state` is `APPROVED` and its webhook twin whose `state` is
  `approved`, the two subsets are identical and enqueue identical jobs.

## INT-GITLAB-PAYLOAD-SUBSET

**GitLab → receiver.** The sibling of `INT-WEBHOOK-PAYLOAD-SUBSET`, kept separate because a GitLab
payload is a different shape rather than an extension of GitHub's.

- **Contract**:
  - Events consumed: `Issue Hook`, `Note Hook`, `Merge Request Hook` (`object_kind`: `issue`, `note`,
    `merge_request`). Everything else drops as `unhandled-event`.
  - Headers consumed: `X-Gitlab-Event`; `webhook-id` **or** `Idempotency-Key` (the delivery id); and, per
    the endpoint's declared mode, either `webhook-signature` + `webhook-timestamp` or `X-Gitlab-Token`.
  - Body fields consumed: `object_kind`, `user.id`, `user.username`, `project.id`,
    `project.path_with_namespace`, `project.default_branch`, `object_attributes.{iid, title, description,
    action, note, noteable_type, labels[].title, oldrev}`, `changes.labels.{previous, current}[].title`,
    and for a note event the noteable's `{iid, title, description, labels[].title}` under `issue` or
    `merge_request`.
  - **Everything else is ignored.**
  - **The `close` action is consumed** (issue #231), on issues and merge requests, routed to the close
    rules and gated by the existing every-delivery member lookup — the sender IS the closer, so no new
    field and no new mechanism. On an issue, the close route runs FIRST and, when the same delivery also
    carries a `changes.labels` addition, falls back to the label route: a real GitLab call can close and
    label at once, that delivery fires label rules today, and it must keep doing so — one delivery, one
    job, close taking precedence when both match. **No field is added by #231**: `object_attributes.action`
    was already in the list above.
  - **`changes.labels` — the DIFF is the trigger.** GitLab has no `labeled` action; adding a label arrives
    as `action: "update"` with a before/after pair. The label set a rule is tested against is
    `current \ previous`, and an `update` carrying no `changes.labels` matches nothing. Testing the
    *current* set instead — the shape the GitHub path uses, because there a `labeled` action already means
    "a label just moved" — would re-fire on every later edit of an already-labelled issue: retitle it,
    reassign it, re-milestone it, and each one starts another paid run. `open` is the single case with no
    previous set, and there the whole set is the addition.
  - **`noteable_type`** states whether a comment is on an issue or a merge request, where GitHub infers it
    from the presence of `issue.pull_request`. Routing it wrong mints a `pi/issue-<n>` branch for
    something that is already a merge request: wrong work, no error, and it reads as a successful run.
  - **`user.username`** is carried, where GitHub's `sender.login` is deliberately dropped, because GitLab
    puts no access level in the payload and the member lookup needs an identity. It is **personal data**
    with exactly one consumer: it reaches the resolver and goes no further — never a log line, never the
    job, never the run record (`no-pii-in-logs`).
- **`iid`, never `id`.** `iid` is the per-project number a human sees and an API path takes; `id` is a
  global database key that would address a valid-looking object belonging to somebody else.
- **The project is carried as its numeric `id`**, with `path_with_namespace` kept only as a human-readable
  label for logs, run history and pause-window scopes. A GitLab project path is `group/subgroup/project`
  with no fixed segment count, so the `owner/name` split the GitHub path uses does not merely fail on one
  — it **succeeds wrongly**, both halves non-empty, and the project silently becomes its own parent group.
- **Why**: Naming the subset **is** the contract, for the reason its sibling states: because everything
  unlisted is ignored by construction, an upstream schema addition cannot change our behaviour, and a
  reviewer sees the entire attack surface as one list. Every field here is attacker-controlled except the
  headers, and the headers are only trustworthy after `CONST-HMAC-OVER-RAW-BODY` has run. Unlike GitHub's
  `author_association`, **nothing in this list establishes authority** — GitLab computes no such field, so
  the approval gate is an API lookup performed outside the filter (`REQ-TRIGGER-AUTHOR-GATE`).
- **Traces to**: `CONST-HMAC-OVER-RAW-BODY`, `REQ-TRIGGER-AUTHOR-GATE`, `REQ-DEDUP-BY-DELIVERY-GUID`,
  `INT-CONTAINER-JOB-INPUTS`, `INT-WEBHOOK-PAYLOAD-SUBSET`
- **Acceptance**: Given a payload with unknown extra fields, behaviour is unchanged. Given an `update`
  whose `changes` carries no `labels`, no job is enqueued. Given a note whose `noteable_type` is
  `MergeRequest`, the job's target type is `pull_request`. No enqueued job, log line or run record
  contains `user.username`.

## INT-FORGEJO-PAYLOAD-SUBSET

**Forgejo/Gitea → receiver.** A sibling of `INT-WEBHOOK-PAYLOAD-SUBSET`, and the closest of the three to
it — which is precisely why it is separate. "Almost the same" is the shape that breaks quietly.

- **Contract**:
  - Events consumed: `issues`, `issue_comment`, `pull_request` — the `X-GitHub-Event` values Forgejo
    emits verbatim. Everything else drops as `unhandled-event`.
  - Headers consumed: `X-GitHub-Event`, `X-GitHub-Delivery` (the delivery id), `X-Hub-Signature-256`.
    These are GitHub's names, sent by Forgejo unchanged, and read by **unmodified** `verify.mjs`.
  - Body fields consumed: `action`, `sender.{id, login}`, `is_pull`, `issue.{number, title, body,
    labels[].name}`, `comment.body`, `pull_request.{number, title, body, labels[].name, head.{ref, sha,
    repo.full_name}, base.ref}`, `repository.full_name`.
  - **Everything else is ignored.**
- **The action vocabulary is Forgejo's, and the mismatch is SILENT.** `HookEventType.Event()` reports an
  `issue_label` event as `X-GitHub-Event: issues` carrying `"action": "label_updated"`. Read against
  GitHub's vocabulary that passes the event check, fails the action check, and falls out as
  `unhandled-event`: HTTP 200, no job, no error, and nothing that says why. So the map is explicit —
  `label_updated` → `labeled`, `synchronized` → `synchronize` — and an action that is RECOGNISED but not
  actionable drops under its own reason (`action-not-actionable`), so "Forgejo said something we
  deliberately ignore" is distinguishable from "we did not recognise this".
- **`label_cleared` maps to nothing, permanently.** It has no GitHub counterpart, so there is no rule for
  it to inherit: removing a label must never start a paid run, and it has to be stated rather than assumed.
- **`closed` moved OUT of the recognised-but-not-actionable set** (issue #231) into both action maps —
  a word sits in the ignored set or an action map, never both — and routes to the close rules, gated by
  the existing every-delivery permission lookup (the sender IS the closer). A close matching no armed
  close rule now drops `no-matching-close-trigger` where it dropped `action-not-actionable`. **No field
  is added by #231.**
- **`is_pull` is TOP-LEVEL**, where GitHub carries `issue.pull_request`. Reading the wrong one routes every
  pull-request comment as an issue, and the envelope then tells the agent to open `pi/issue-<n>` for
  something that is already a pull request: wrong work, no error, and it reads as a successful run.
- **`sender.login` is carried**, where GitHub's is deliberately dropped, because Forgejo computes no
  `author_association` and the collaborator-permission lookup takes a username — Forgejo's endpoint offers
  no numeric-id form. It is **personal data** with exactly one consumer: it reaches the resolver and goes
  no further — never a log line, never the job, never the run record (`no-pii-in-logs`).
- **Why**: Naming the subset **is** the contract, for the reason its siblings state. What is specific here
  is that Forgejo's transport is byte-compatible with GitHub's, so `CONST-HMAC-OVER-RAW-BODY` and
  `REQ-DEDUP-BY-DELIVERY-GUID` are satisfied by EXISTING code rather than new code — and that is exactly
  the condition under which a shared projection would have looked correct and been wrong in three places.
- **Traces to**: `CONST-HMAC-OVER-RAW-BODY`, `CONST-TRIGGER-AUTHOR-GATE`, `REQ-TRIGGER-AUTHOR-GATE`,
  `REQ-DEDUP-BY-DELIVERY-GUID`, `INT-WEBHOOK-PAYLOAD-SUBSET`
- **Acceptance**: Given `action: "label_updated"` on an allowlisted label, a job is enqueued. Given
  `label_cleared`, none is, and the drop reason is not `unhandled-event`. Given a comment whose `is_pull`
  is true, the job's target type is `pull_request`. A delivery signed with any other endpoint's secret
  returns 401 through unmodified `verify.mjs`. No enqueued job, log line or run record contains
  `sender.login`.

---

## INT-AZURE-PAYLOAD-SUBSET

**Azure DevOps → receiver.** A sibling of `INT-WEBHOOK-PAYLOAD-SUBSET`, and the one that shares least
with it: no delivery-id header, two actor representations, tags as a string, and a scope triple.

- **Contract**:
  - Events consumed: `workitem.created`, `workitem.updated`, `workitem.commented`,
    `git.pullrequest.created`, `git.pullrequest.updated`, `ms.vss-code.git-pullrequest-comment-event`.
    Everything else drops as `unhandled-event`.
  - Headers consumed: `Authorization` (Basic) **or** one operator-named custom header, per the endpoint's
    declared mode. There is no signature header and no delivery-id header.
  - Body fields consumed: `id`, `eventType`, `resourceContainers.project.id`, and per event class:
    `resource.{id, workItemId, fields, revision.fields}` for a work item;
    `resource.{pullRequestId, title, description, sourceRefName, targetRefName, createdBy.id,
    repository.{id, name, project.{id, name}}}` for a pull request; `resource.comment.{content, author.id}`
    and `resource.pullRequest.*` for a pull-request comment.
  - **Everything else is ignored** — including `message` and `detailedMessage`, which are pre-rendered
    prose containing the work item's title and are exactly the kind of field that looks convenient and
    drags untrusted text into a place it was never classified for.
- **The delivery id is in the BODY.** Azure sends no delivery-id header at all, so
  `REQ-DEDUP-BY-DELIVERY-GUID`'s key is the payload's top-level `id` GUID, read after the credential check.
  `notificationId` is **not** it: that is a per-subscription integer sequence, so two subscriptions collide
  on delivery 1. A delivery carrying no `id` is refused with 400 rather than run undeduplicated.
- **Two actor representations, inside one forge.** A pull-request event carries `resource.createdBy.id`, a
  GUID. A work-item event carries the actor ONLY as the string `"Display Name <email>"` in
  `System.CreatedBy` / `System.ChangedBy`, with no id anywhere. Both the author gate and the bot-loop guard
  therefore handle two forms, and the address is extracted with an **anchored** trailing `<...>` match: the
  display half is attacker-settable, so a substring test would let
  `"pi-bot@example.com is not me <mallory@evil.test>"` read as the harness.
- **Tags are a semicolon STRING, and on an update they arrive as a DIFF.** `System.Tags` is
  `"performance;urgent"`, normalised to the `[{name}]` shape `predicate.mjs` reads (trimmed, because the
  spacing has varied across resource versions). Azure has no `labeled` event: a tag change arrives as
  `workitem.updated` with a `{oldValue, newValue}` pair, and the set a rule is tested against is
  `newValue \ oldValue`. Testing the CURRENT set would re-fire on every later edit of any field on a tagged
  work item — a paid run per typo fix, forever. This is `INT-GITLAB-PAYLOAD-SUBSET`'s `changes.labels` trap,
  arrived at from a different direction.
- **The scope is a triple, and a work item names only two of it.** `resourceContainers.project` plus the
  work item's `System.TeamProject` give the project; a work item belongs to a PROJECT and a project may
  hold many repositories, so the REPOSITORY comes from the matched rule's `run.repository`. A pull-request
  event names its own and that is authoritative.
- **`System.Description` is rich text (HTML)** on most work item types. It stays DATA either way — fenced
  below the delimiter like every other payload string (`CONST-ISSUE-TEXT-IS-DATA`) — but the envelope says
  so, because an agent handed markup where it expected Markdown will otherwise guess.
- **Why**: Naming the subset **is** the contract. What is specific here is that the headers are NOT
  trustworthy in the sense the other three enjoy: the credential proves the sender knew a secret and covers
  no bytes (`CONST-HMAC-OVER-RAW-BODY`), so every field in this list is attacker-controlled to anyone who
  holds it. That is why the list is short and why `message`/`detailedMessage` are excluded.
- **Traces to**: `CONST-HMAC-OVER-RAW-BODY`, `CONST-TRIGGER-AUTHOR-GATE`, `REQ-TRIGGER-AUTHOR-GATE`,
  `REQ-DEDUP-BY-DELIVERY-GUID`, `INT-WEBHOOK-PAYLOAD-SUBSET`, `OQ-015`
- **Acceptance**: Given a `workitem.updated` whose `fields` carries no `System.Tags` pair, no job is
  enqueued. Given one whose tag change is a removal only, none is. Given a delivery with no top-level `id`,
  the receiver returns 400. No enqueued job, log line or run record contains an email address — a
  work-item actor reaches the run record as a SHA-256 prefix, never as the address itself.

---

## INT-TRIGGERS-FILE-CONTRACT

**operator → worker + receiver.** One unified file, read by both services; each validates the WHOLE file
and selects the `on.type` it owns (worker: `cron`; receiver: `label`, `comment`, `pull_request`, `issue`).

- **Contract**:
  ```
  triggers.json  (path via PI_TRIGGERS_FILE; absolute; unset = cron disabled for the worker; the
                  receiver falls back to ./triggers.json in its working directory — the file
                  `pi-dispatch init` scaffolds — and refuses to start when neither exists)
  { "triggers": [
    { "on": { "type": "cron", "id": "<[A-Za-z0-9._-]+, no ':' , unique>",
              "pattern": "<5 or 6 space-separated fields>" },
      "run": { "kind": "local", "folder": "<absolute HOST path, must exist>", "flow": "<flow name>",
               "command": "<registered pi command [args] — EXACTLY ONE of flow/command, every kind>",
               "task": "<operator-authored prompt text — DATA, lands in /job/prompt.md; NOT beside command>",
               "provider": "<optional passthrough>", "model": "<optional>", "maxTurns": <optional>,
               "github": <optional boolean>, "packages": <optional boolean>,
               "resume": <optional boolean>,
               "image": "<optional: docker image ref; absent = PI_JOB_IMAGE>",
               "skillsDir": "<optional: absolute WORKER-HOST dir of <name>/SKILL.md skills>",
               "secrets": <optional { "ENV_NAME": "<opaque reference for YOUR resolver>" }, max 16; ALL kinds>,
               "secretsProfile": "<optional: which declared resolver reads them; absent = the profile named `default`>" } },
    { "on": { "type": "label", "any": [...], "all": [...], "none": [...] },
      "run": { "kind": "github", "flow": "<flow name>",
               "command": "<see cron — exactly one of flow/command>", "packages": <optional boolean>,
               "image": "<optional>", "skillsDir": "<optional>",
               "instructions": "<optional: operator standing text, <=2000 chars; NOT on cron, NOT beside command>",
               "replicas": <optional int 2..3; webhook kinds only>,
               "secrets": <optional { "ENV_NAME": "<opaque reference for YOUR resolver>" }, max 16; ALL kinds>,
               "secretsProfile": "<optional: which declared resolver reads them; absent = the profile named `default`>" } },
    { "on": { "type": "comment", "phrase": "<trigger phrase>" },       // at most one
      "run": { "kind": "github", "flow": "<default flow>",
               "command": "<see cron — exactly one of flow/command>", "packages": <optional boolean>,
               "image": "<optional>", "skillsDir": "<optional>",
               "instructions": "<optional: operator standing text, <=2000 chars; NOT on cron, NOT beside command>",
               "replicas": <optional int 2..3; webhook kinds only>,
               "secrets": <optional { "ENV_NAME": "<opaque reference for YOUR resolver>" }, max 16; ALL kinds>,
               "secretsProfile": "<optional: which declared resolver reads them; absent = the profile named `default`>" } },
    { "on": { "type": "pull_request",
              "action": ["labeled"|"opened"|"synchronize"|"reopened"|"review_submitted"|"closed", ...],
                                                                    // the close word is close-ONLY:
                                                                    // never mixed with other actions
              "reviewState": ["approved"|"changes_requested"|"commented", ...],  // optional; github only,
                                                                    // and only beside review_submitted
              "any": [...], "all": [...], "none": [...],            // refused on a close-only rule
              "number": <optional int >= 1; close-only rules>,
              "once": <optional boolean; close-only rules; true requires number>,
              "disarmed": { "at": "<time>", "jobId": "<optional>" } },  // written by the worker; only
                                                                    // beside once: true
      "run": { "kind": "github", "flow": "<flow name>",
               "command": "<see cron — exactly one of flow/command>", "packages": <optional boolean>,
               "image": "<optional>", "skillsDir": "<optional>",
               "instructions": "<optional: operator standing text, <=2000 chars; NOT on cron, NOT beside command>",
               "replicas": <optional int 2..3; webhook kinds only; never beside once: true>,
               "secrets": <optional { "ENV_NAME": "<opaque reference for YOUR resolver>" }, max 16; ALL kinds>,
               "secretsProfile": "<optional: which declared resolver reads them; absent = the profile named `default`>" } },
    { "on": { "type": "issue", "action": ["closed"|"close", ...],   // per forge; azure refused at load
              "number": <optional int >= 1>,
              "once": <optional boolean; true requires number>,
              "disarmed": { "at": "<time>", "jobId": "<optional>" } },  // written by the worker
      "run": { "kind": "github", "flow": "<flow name>",
               "command": "<see cron — exactly one of flow/command>",
               "<the label entry's optional run fields apply unchanged; replicas never beside once: true>": "" } } ] }
  ```
- **The on × run MATRIX is the trust boundary, enforced fail-loud at load**: `cron ⟹ run.kind:"local"`;
  every webhook type (`label`, `comment`, `pull_request`, `issue`) `⟹ run.kind ∈ {"github", "gitlab", "forgejo", "azure"}` — a forge
  job, never a local one. Off-matrix throws a `piDispatchConfig` error — a `cron` trigger has no webhook
  delivery, issue/PR number, title, or body to supply a forge run, and a webhook trigger is adversarial
  input that always produces a forge job.
- **`run.command` (ALL FOUR trigger kinds) — the second entry point, and the file's one either/or pair:
  EXACTLY ONE of `run.flow` or `run.command`, refused at parse in both services when both are present and
  when neither is** (`DES-COMMAND-ENTRY-POINT`; the shared validator is what makes the refusal identical
  on both sides, `DES-TRIGGERS-UNIFIED-FILE`). The value names a **registered pi extension command**,
  optionally followed by arguments — `"wf run nightly"` dispatches as pi's own `/wf run nightly`.
  **Validated at parse exactly as the runner validates `PI_COMMAND`**, so a value that loads never
  refuses in-container: a non-empty string with **no leading slash** (the slash is dispatch syntax, added
  by the runner — a written one would dispatch `//name`), **no surrounding whitespace** (`run.image`'s
  reason: the reviewed file must not disagree with what runs, and pi's grammar reads the name to the
  first space), and **no control characters** (everything after the first space reaches the handler
  verbatim as args, so a control byte would ride into the handler unseen).
  **The prompt is EXACTLY `/<command> [args]`** — no envelope, no numbered steps, no data heading, no
  pointer at `event.json`, no trailing newline — **for local AND forge command jobs alike**
  (`DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE` records why the bypass changes no existing prompt).
  Delivery context rides `/job/event.json`, which the handler parses itself; the payload therefore
  reaches a command job **only as a file the handler chooses to read**, which preserves
  `CONST-ISSUE-TEXT-IS-DATA` and arguably strengthens it — nothing attacker-authored is rendered into
  the prompt at all.
  **Args are static, and that is doctrine rather than a limitation**: they come only from the reviewed
  file, so WHAT dispatches is decided entirely by the operator's edit; the dynamic channel is
  `event.json`. A command that must react to the delivery reads the file; interpolating payload text
  into args would put attacker text on the dispatch line.
  **Three fields are refused beside it, each for its own reason.** `run.task` (cron), because a command
  job's prompt is exactly the dispatch line — the task would render nowhere, the
  accepted-where-it-does-nothing hazard. `run.instructions` (webhook), because the envelope it renders
  into is bypassed. `run.resume: true`, as *not yet covered* on cron-`resume`'s precedent: a resumed
  session replays a transcript into a job whose prompt must be exactly the dispatch line, and nothing has
  decided what that means. `replicas`/`image`/`packages`/`skillsDir`/`repository`/`github` stay
  orthogonal — they configure the box, not the entry point.
  **The comment trigger's `<phrase> <flow>` trailing-word override is INERT on a command rule.** That
  channel lets a collaborator retarget a flow trigger; a collaborator must not retarget or SUPPRESS a
  command by appending words, so on a command rule trailing text is data like the rest of the comment,
  reaching the handler only via `event.json`. The receiver's `knownFlows` set is built from
  flow-carrying triggers only, so a command name never becomes summonable by comment either; grouped
  rules carry `command` through to the filter, and an enqueued command job's `data` carries `command`
  and no `flow`.
  **Never AI-reachable, and stricter than flows**: a chain request carrying a `command` key refuses
  outright (`chain-command-refused`, `INT-OUTBOX-CONTRACT` — before the charset check, with no opt-in,
  unlike injected skills' fallen-out unreachability, because a command prompt is BUILT at the producers
  and there is no committed artifact a gate could read; `OQ-022`, with the inversion stated there);
  `dispatch_run` refuses a slash-leading flow with a readable message and is otherwise structurally
  incapable (its params are `{folder, flow, task}`), and `dispatch_trigger_add`/`_edit` carry no
  `command` parameter — `run.image`'s "deliberately no model-callable path" clause, applied to the entry
  point itself.
  **Worker mechanics, named here because the file's reader meets them first**: the command line rides
  `PI_COMMAND` (omit-when-absent, `INT-CONTAINER-JOB-INPUTS`); the forge semantic-dedup key carries the
  `cmd:`-prefixed command in the flow slot, so a command rule and a flow rule spelling the same name
  never coalesce; the image preflight refuses a command job **pre-spend** on an image whose capability
  label does not declare `commands` (`job-image-commands-unsupported`, budget unreserved — the
  `replicas` pattern), because an older runner would feed `/name args` to the model as prose; and
  `doctor` reports the file's command-trigger count with one advisory line, because registration is
  verifiable only in-container — the runner's `command-unregistered` refusal is the exact layer, and a
  host-side preflight cannot load the image's extensions.
- **`run.skillsDir` (optional, all four kinds)** names a directory of operator-authored skills on the
  WORKER host, in the `<name>/SKILL.md` layout `~/.pi/agent/skills` already uses. Its contents are COPIED
  into the per-job dir and reach the container at `/job/trigger-skills`, layered between the repo's own
  `.pi/skills` and the global overlay: **repo > injected > overlay** (`REQ-PER-TRIGGER-SKILLS`,
  `INT-SDK-SESSION-OPTIONS`). Accepted on every kind for `run.image`'s reason: a skill set is a capability
  of the FLOW, and a webhook trigger runs the flows a cron trigger runs.
  **Copied rather than mounted**, and that is the decision rather than an implementation detail: `:ro`
  bounds the container, not the host, and pi reads a skill's body on demand, so a live bind could change
  under a running agent. The copy pins the instruction set for the life of the job, exactly as
  materialising `.pi/` at a fixed sha does for the repo's own. It also adds **no mount**, so
  `CONST-ISOLATION-CONTAINER-PER-JOB`'s enumeration is untouched, and it answers symlinks once on the host
  side rather than handing pi a tree whose links it would follow.
  **Validated as a non-empty, untrimmed string HERE and no further**, deliberately. Existence is not
  checked, because BOTH services parse this file and the receiver may run on another host (the `run.folder`
  split). Absoluteness is not checked either, because `path.isAbsolute` is OS-dependent, so a shared check
  would let a Windows worker and a Linux receiver disagree about the same reviewed file. The worker
  enforces both where the answer is knowable: at boot for cron, and pre-spend per job for every kind, where
  an absent or non-directory path is the policy refusal `skills-dir-missing`. A cap breach or an empty
  directory refuses in prepare as `skills-dir-too-large`, `skills-dir-too-many-files`,
  `skills-dir-too-deep`, `skills-dir-unreadable` or `skills-dir-empty` -- all pre-budget, all returned.
  **Empty is a refusal, not a no-op**: an operator who pointed at the wrong directory and got an unchanged
  job is the silent failure this project refuses.
  **The value never reaches `/job/event.json`.** It rides at JOB level and never inside `trigger`, which is
  the object the event subset is built from -- a worker-host path in an agent-readable file is exactly what
  `prepare-local`'s `folder: basename(folder)` restraint already exists to prevent.
  **Injected skills are trigger-reachable and never AI-reachable.** `DES-AI-TRIGGER-FLOW-GATE` reads the
  target repo's committed `.pi/skills/<flow>/SKILL.md` from the object store at a pinned sha, and an
  injected skill has no object-store presence, so a chain request or a `dispatch_run` naming one resolves
  `no-skill` and is refused. An injected `SKILL.md` carrying `ai-trigger: allow` is therefore **never
  read**; `doctor` warns when one is present, because nothing else would tell the operator their opt-in is
  inert.
- **`run.instructions` (optional, the three webhook types only)** is one line of operator standing text,
  rendered into the USER prompt's **instruction region**: above the fenced data region, below the
  harness's own numbered steps, and before the never-merge paragraph, so the harness keeps the last word
  (`REQ-PER-TRIGGER-INSTRUCTION`, `DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE`). It is never fenced, because
  a fence is this prompt's DATA marker, and it carries a sentence naming its provenance so the model can
  tell it from the payload. `CONST-ISSUE-TEXT-IS-DATA` is amended for exactly this region.
  **Refused on cron**, naming `run.task`: a local job's prompt IS `run.task`, with no envelope, no data
  heading and no fence, so there is no standing region distinct from the task for a second field to
  occupy, and two fields writing one region with an undefined order would both appear to work.
  **Capped at 2000 characters and refused rather than truncated**, because the reviewed file must not
  disagree with what runs. The cap is NOT a caching bound -- the text is written once and `prompt()` is
  called once, and at the pin pi-ai caches the last user message too -- it bounds a context overflow
  inside a PAID container that would otherwise have no pre-spend signal, and it keeps the field in its
  lane, since anything longer belongs in the flow's `SKILL.md` or the overlay persona. Both are named in
  the refusal. Surrounding whitespace is NOT refused, unlike `run.image`, because whitespace changes what
  an image reference means and does not change what prose means; a whitespace-only value is.
  It rides at JOB level and never inside `trigger`, so it reaches `/job/prompt.md` and never
  `/job/event.json` or the run record.
- **`run.kind` selects the forge; `on.type` is shared.** A label is a label and a comment is a comment on
  any forge, so the trigger types and their `{any, all, none}` predicates are identical. The **action**
  vocabulary is not, and is validated against the vocabulary of whichever forge the entry names:
  `github` takes `labeled|opened|synchronize|reopened|review_submitted|closed`, `gitlab` takes
  `open|update|reopen|approved|close` — each
  in that forge's own words, so an operator can grep their own documentation for them. GitLab has no
  `labeled` (a label added to a merge request arrives as `update` with a `changes.labels` diff) and no
  `synchronize` (an `update` carrying `oldrev` is the analogue). The close words carry a distinction the
  pre-#231 wording ("nothing left to act on") folded flat: a job **about** the closed thing still has
  nothing left to act on, and that refusal stands, but a close can **release separately-armed work** — an
  operator wrote "when this closes, run that" into this file, and the close is the starting gun, not the
  subject. `merge` stays omitted everywhere, and what covers it varies by forge, stated rather than
  glossed: GitHub and Forgejo emit `closed` for a merged PR, so a close rule fires on merge-closes
  there; GitLab reports a merge as its own `merge` action, which no rule takes, so on GitLab a close
  rule fires on an explicit close only — a gap an operator plans around, not a limit hidden behind
  the close word.
  **The refusal matters more than it looks**: an action word from the wrong forge is not malformed and
  breaks nothing downstream — it simply never matches an event, so the trigger loads clean and is
  silently dead. Refusing at load is what turns that into a message.
- **`review_submitted` is the one action word that names an event as well as an action** (issue #66), and
  it is the one place ONE `on.type` spans two GitHub event names: it is `pull_request_review`'s `submitted`
  action, spelled as a compound so both halves stay greppable in GitHub's docs, exactly as Forgejo's
  `label_updated` is spelled Forgejo's way. It rides `pull_request` rather than becoming a fifth `on.type`
  because GitLab's analogue `approved` already rides `pull_request`, and a new type would have made one
  forge's review a type and the other's an action. GitLab's `approved` is **not** this word renamed:
  `approved` is one verdict, `review_submitted` is every verdict, which is what `on.reviewState` narrows.
- **`on.reviewState` (optional, github only, and only beside `review_submitted`)** narrows which review
  verdicts may start a job; omitted means all three. It exists because `review_submitted` is a WIDER paid
  surface than any other GitHub trigger — a `commented` review needs no phrase, unlike a comment trigger,
  and no label, unlike a `labeled` one, so arming the action arms every drive-by "lgtm thanks". Four
  refusals at load, all the same call the action vocabulary makes: a word outside
  `approved|changes_requested|commented`, an empty or non-array value, the field on a non-github entry, and
  the field on an entry whose actions do not include `review_submitted` — that last one because a
  `reviewState` beside `["opened","synchronize"]` reads as "only run for these verdicts" and does the exact
  opposite. An unlisted verdict drops as `review-state-not-matched`, distinct from `no-matching-pr-trigger`,
  because "your rule exists and this verdict was not in your list" and "no rule matched" call for different
  operator responses.
- **A `labeled` github `pull_request` rule must carry a positive selector; a gitlab one need not.** Not an
  inconsistency: on GitHub the predicate IS the approval gate for that action, so a rule without one is
  ungated. Every gitlab trigger is additionally gated on the actor's resolved access level
  (`CONST-TRIGGER-AUTHOR-GATE`), so there is no ungated case for a predicate to have to close. A **label**
  trigger still requires a positive selector on both forges, because a `none`-only rule fires on any
  labelling event at all.
- **At most one `comment` trigger PER FORGE.** The receiver holds one comment rule per forge and a second
  would be silently unreachable, so the cap is on ambiguity rather than on count — and a deployment
  serving both forges is entitled to answer `@pi` on each.
- **`on.type: "issue"` and the close-only `pull_request` rule (issue #231)** are the close triggers: fire
  when an item closes, on the authority of the actor who CLOSED it (`CONST-TRIGGER-AUTHOR-GATE`'s close
  arm). **#231 lands in slices, and each clause below names its slice where it is not this one**: the
  schema slice (this row's) makes the shapes load, validate, refuse, and display; the receiver slice
  routes closes and extends `decideServesGithub` and the close groups; the worker slice writes the
  disarm. Until its slice lands, a close rule loads clean and is deliberately inert — grouped by neither
  service, matched by nothing — which is the loud-skew widening `DES-TRIGGERS-UNIFIED-FILE` records, not
  the silent-no-op it forbids. An issue close is a TYPE because every other issue event already has a home (`label` for label
  predicates, `comment` for phrases) and neither shape fits a close — no label diff, no phrase, only an
  action, an item number and an actor. A PULL REQUEST's close is an ACTION on `pull_request`, the
  `review_submitted` rule applied again: one forge's PR lifecycle must not be a type while another's is an
  action. The split also settles what a single both-kinds type could not: GitLab and Azure number issues
  and merge/pull requests from **separate sequences**, so under one type `on.number` would be ambiguous
  exactly where a one-shot spending itself on the wrong `#5` hurts most — the type IS the discriminator.
  **A close word never mixes with other actions in one rule** (refused at load): a close rule is gated on
  the closer's write access, every other PR action on the author's association or a collaborator-applied
  label, and one rule cannot gate on two different actors. **Label predicates are refused on both close
  shapes** — the close route matches action and `number` alone, so `any`/`all`/`none` would sit in the
  file looking configured and never match. **`azure` is refused at load for both** — *not yet covered*,
  `run.resume`'s vocabulary: a work item's close is a `System.State` transition whose terminal names vary
  by process template, the projected subset carries only `System.Tags`, and a PR abandon arrives as
  `git.pullrequest.updated` with nothing in the subset to tell it from any other update, so support waits
  on a payload-subset widening, not on a decision.
- **`on.number` (close shapes only, optional int >= 1)** narrows the rule to ONE item, by the number the
  forge itself assigns (on GitLab, the iid). Legal with or without `once` — a standing "every close of
  #40" rule is coherent narrowing, `on.reviewState`'s precedent. On any other trigger shape it is refused
  at load (*not yet covered* on the webhook kinds, not available on cron), never accepted-and-ignored.
- **`on.once` (close shapes only, optional strict boolean) — the one-shot** (`DES-ONE-SHOT-DISARM-IN-THE-FILE`).
  `false` is legal and carried (an operator who wrote down today's default is not refused for it).
  **`true` requires `on.number`**, a race analysis rather than taste: a numberless one-shot matched by two
  different items' closes inside one dedup window enqueues both before either disarm lands, and which item
  "spent" the trigger is a coin flip — with a number, concurrent duplicates are duplicates of the SAME
  item, which is what the delivery GUID and the semantic window actually bound. The number is also the
  identity the disarm re-checks before it writes. **`once: true` is refused beside `run.replicas`**
  (`false`, the written-down default, is carried): "exactly one run" and
  "N sandboxes race" contradict, and with N run records the disarm no longer says which one spent the
  trigger.
- **`on.disarmed` (`{ at, jobId? }`, only beside `once: true`) — the spent mark, and the sentinel.** The
  WORKER writes it (its disarm writer is the worker slice) after the one-shot's run record exists, by
  adding exactly this key to exactly this entry; an operator may hand-write it to disarm deliberately,
  and deletes it to re-arm. A disarmed entry
  **still validates in full** (a corrupted disarm mark is a load refusal, never a silently-still-armed
  rule) and **still occupies its raw array position** — deleting it would shift `triggerIndex` attribution
  for every later entry — but it **normalizes to the sentinel `{ on: { type: "disarmed" }, run: {} }`**,
  producible only by the validator (`ON_TYPES` excludes the word, so an authored `on.type: "disarmed"`
  refuses like any unknown type). The sentinel carries no selectors, no actions, no `run.kind` and no
  flow, so no receiver group, no schedule, no flow allowlist and no doctor fact can ever pick it up:
  "nothing downstream can match a spent one-shot" is a validator guarantee, not a consumer discipline.
  Two deliberate consequences are part of the contract rather than side effects: a spent entry's flow
  leaves the receiver's `knownFlows` comment-override allowlist (an allowlist of ARMED intent), and a
  spent sole-github-rule deployment recomputes `servesGithub` accordingly at its next boot — the second
  becomes decidable for both close shapes only when the receiver slice teaches `decideServesGithub` the
  close groups, and that extension is part of that slice's contract, not an option.
- **`run.flow` must match the skill-name charset on the webhook kinds** (issue #231): materialize refuses
  a name outside it at job start, AFTER the budget slot is reserved, so until #231 a charset-invalid forge
  flow loaded clean and could only ever fail in-container (the graph's `charset-invalid` defect). Refusing
  at load turns a paid failure into a free one — and it is what keeps `:` out of the flow slot of the
  semantic dedup key, where the `cmd:` prefix lives and the receiver slice's close-job discriminant will
  sit beside it. Cron is deliberately exempt: a
  local flow resolves inside the operator's own folder by pi itself, and the semantic key does not apply
  to repeat jobs. This is the file's one **narrowing** since the widening doctrine was written: an old
  file carrying such a flow now refuses loudly at boot (or keeps last-good on live reload) instead of
  failing paid — named in the release notes because the refusal is new, not because the flow ever worked.
- **`run.github` (cron only, optional boolean)**: absent or `false` = no token — the zero-GitHub default;
  `true` = the worker mints the same per-job token the GitHub path mints and injects it as
  `GITHUB_TOKEN`/`GH_TOKEN` (`INT-CONTAINER-RUNTIME-CONTRACT`), so the flow can use the `gh` CLI. A
  non-boolean value is refused at load; with `GITHUB_AUTH_SOURCE=app` a `run.github` job refuses at mint
  time — an installation token is per-repo, and a local job has no repo to scope it to.
- **`run.resume` (github/gitlab/forgejo/azure triggers, optional boolean) — an opt-IN, and the polarity is deliberate.**
  Absent or `false` = today's behaviour: no transcript on disk, no `/session` mount, byte-identical argv.
  `true` = this trigger's jobs continue the session the previous job for the same key produced
  (`REQ-RESUMABLE-SESSION`, `INT-SESSION-STORE-CONTRACT`). The polarity is the **opposite** of
  `run.packages` below, and the two flags gate different kinds of thing: staging a pi package is an
  operator act already performed, so the set they staged is the set their jobs get and a trigger opts
  *out*; persisting a transcript is a **disclosure** — the agent's full working history, tool output, file
  contents and its own reasoning, written to host disk and replayed into a later job — and disclosures
  default off. Non-boolean is refused at load, and here the damaging misreading runs the other way from
  `run.packages`': a truthy `"false"` string reads to an operator as an opt-out and would arm the
  disclosure instead. **`run.resume: true` on a `cron` trigger is refused at load**, on `run.replicas`'
  precedent and with its own reason: `resolveSession` is handed to the forge preparers only, so a local job
  would stage no transcript, mount no `/session` and promote nothing, then exit `0` as though it had — the
  same believed-on-while-off inversion the flag's polarity exists to prevent, arriving through the wiring
  instead of through a string. It is *not yet covered* rather than impossible: `session-key.mjs` already
  derives a local key from the scheduler id, which is the one key in this feature chosen by nobody
  untrusted, and nothing reaches it. Only `true` is refused; `false` and absent still validate and still
  land in `data` byte-identically, because `false` is the documented default and refusing it would refuse
  an operator for writing down present behaviour. That asymmetry with `run.replicas` — which refuses ANY
  value on cron — is deliberate: `1` is itself a no-op flag, where `false` is the truth.
  **A second refusal is pre-spend, not at load**: an armed trigger whose deployment has no
  `PI_SESSIONS_DIR` refuses every delivery as `sessions-dir-unset` (`INT-RUN-HISTORY-FILE-CONTRACT`'s enum)
  before the mint, the clone and the budget reservation — fail-CLOSED, the one case in this feature that
  does not fail open, since a cold start is a correct run and a silently sessionless armed job is not. The
  triggers file cannot answer that one: whether a store exists is deployment state, not file content, so
  `doctor` is the load-time warning and the per-delivery refusal is the enforcement.
- **`run.packages` (ALL FOUR trigger kinds, optional boolean) — an opt-OUT**: absent or `true` = the
  worker emits `PI_PACKAGES` with the container paths of the pi packages the operator staged into the
  global overlay (`INT-PI-PACKAGES-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`), so the flow gets
  their extensions and skills; **only an explicit `false` withholds them**. The polarity inverted with the
  overlay's: staging a package is a deliberate, pinned, host-side act (`import-pi --with-packages`), so the
  set an operator staged is the set their jobs get, and the per-trigger flag is how one flow opts *out*
  rather than how every flow opts in. A non-boolean value is still **refused at load** — `parseTriggers`
  validates strict booleans on all four kinds — and the refusal now matters in the opposite direction: the
  damaging misreading used to be a truthy `"true"` string arming a trigger, and is now a `"false"` string
  that looks like an opt-out and is not one. The worker's wiring-time re-check inverted to match
  (`job.packages === false ? [] : packagePaths`), and the strictness that used to live in its `=== true`
  did not disappear — it moved to the load-time validator, where a hand-edited string is refused before it
  can ever become job data. It is carried on all four kinds rather than cron only (unlike `run.github`)
  because a staged package is a **capability of the flow**, and a label/comment/PR trigger runs the same
  flows a cron trigger does. With nothing staged the flag emits nothing at all, which is a silent no-op by
  construction — `doctor` is where that becomes visible.
- **`run.image` (ALL FOUR trigger kinds, optional non-empty string) — a selector, not an arming**: absent
  = the deployment default `PI_JOB_IMAGE`; present = the Docker image this trigger's job containers run in.
  It is **pure passthrough** in exactly the sense `provider`/`model`/`maxTurns` are (**Why**, below):
  omitted → absent from the emitted job data → resolved at job start as `job.image ?? PI_JOB_IMAGE`. Absent
  therefore never means "off"; it means "the deployment's". It is carried on all four kinds for
  `run.packages`' reason and not `run.github`'s: **a toolchain is a capability of the flow**, and a
  label/comment/PR trigger runs the same flows a cron trigger does. A value that is not a non-empty string
  is **refused at load** in both services, as are a value with surrounding whitespace (the file is the
  reviewed artifact and must not disagree with what runs) and one beginning with `-` (it is the final
  positional in the docker argv, where a leading dash parses as a flag). The reference **grammar is
  deliberately not validated** — that is docker's, and a regex over the OCI grammar would refuse the rarer
  half of the problem (a malformed name) while missing the common half (a well-formed name for an image
  nobody built), with an over-strict one refusing a legitimate
  `registry.internal:5000/team/img:1.2@sha256:...` and taking the worker down at boot for a valid
  deployment. A floating tag is accepted for the same reason `CONST-PI-VERSION-PINNED` tolerates it here:
  with `--pull=never` a local tag can only move when a human runs `docker pull` or `docker build` on that
  host, which is the explicit act that constraint asks for.
  **The image decides what is in the box; it never decides what the box can do.** Whatever tag is named
  runs under the whole of `INT-CONTAINER-RUNTIME-CONTRACT` unchanged — the same `ISOLATION_FLAGS`, the same
  closed env allowlist, the same four mounts, all built by the worker's argv and none of them influenced by
  anything an image contains. That contract, which previously never named an image at all, is now the
  **conformance checklist** a nameable image must satisfy, and it says so.
  **A named image must already be present on the host, and two mechanisms enforce that because they do
  different jobs.** A pre-spend `docker image inspect` refuses the job **before `reserveBudget`**, as a
  **policy** outcome and not an infra one (`CONST-RETRY-INFRA-ONLY`: retrying never makes a misspelled tag
  appear; the precedent is `settings-overlay-invalid`) — that is what produces a readable refusal naming
  the tag. `--pull=never` is what makes the registry unreachable from the run itself, so an unknown name
  can never become a silent fetch-and-execute of a stranger's image under a name that looks like the
  operator's. The check is readable but raceable; the flag is unraceable but silent. Neither is sufficient
  alone. `pi-dispatch doctor` reports every distinct image the file names, which is the only warning that
  arrives *before* a 03:00 trigger fires.
  **There is deliberately no model-callable path to this field, and therefore no allowlist.**
  `dispatch_trigger_add`/`_edit` carry **no `image` parameter**, exactly as they carry no `packages`
  parameter; `dispatch_run` carries none; the panel displays it and has no key that sets it; it is **not**
  a settings-overlay key, so `dispatch_set` cannot repoint the fleet. A `PI_JOB_IMAGE_ALLOWLIST` was
  considered and rejected — see `DES-PER-TRIGGER-JOB-IMAGE`. Naming an image is an operator edit to the
  reviewed file.
- **`run.replicas` (`label`/`comment`/`pull_request` on any forge, optional integer `2..3`) — a fanout
  count, and the only field in this file that MULTIPLIES SPEND** (`REQ-REPLICA-RUNS`). Absent = today: one
  delivery, one job, one branch, one pull request, and `data` byte-identical to the pre-feature shape.
  Present = the receiver enqueues exactly that many independent jobs from the one delivery, each carrying
  its own 1-based `replica` index. Every layer that would otherwise collapse them back to one is given the
  index: the jobId (`<prefix><id>-r<i>`, the prefix from the forge table), the semantic dedup key
  (`repo<sep>n:flow:r<i>`, the separator from the same table, so a GitLab MR is `project!5:flow:r2`), the
  minted branch (`pi/issue-<n>-r<i>`), the review-request title marker, and the run record.
  **Webhook only on gitlab/forgejo/azure**: the poller is GitHub-only, so a replica set on those three is
  minted by a delivery and never by a poll.
  **Three refusals, each for its own reason, all fail-loud at load in every loader.** A **`kind: "local"`
  (cron) trigger** is refused because a local job's `/workspace` *is* the operator's folder, bind-mounted
  read-write and edited in place — two replicas would edit one working tree with no gate and no undo,
  where a forge job gets its own `mkdtemp`'d clone. It is also the ONLY kind gate: with forge coverage
  complete (#187) anything that is not `local` is admitted, so this check's position ahead of the range
  check is load-bearing rather than cosmetic. A value outside `2..3` or not an integer is refused, and `1` is refused **rather than
  accepted-and-ignored** — a one-member replica set is a field that does nothing, and a field that does
  nothing is one an operator sets and then trusts. `3` is the ceiling because `PI_CONCURRENCY` defaults to
  3, so a fourth replica would queue rather than race, promising a comparison the deployment cannot
  deliver. Since issue #242 a repo's own `concurrent` limit (`INT-SCOPED-LIMITS-FILE-CONTRACT`) can bound
  a replica set below this ceiling too — by DEFERRAL, the set serializing rather than racing (subject to
  that contract's no-FIFO terms); the ceiling's rationale gains a second bounding axis, not an exception. Finally, **`run.replicas` beside `run.resume: true`** is refused, naming both fields: a resumed
  run continues one lineage and replicas exist to fork it, and this refusal is what lets `session-key.mjs`
  keep deriving its key from the unsuffixed branch — without it every replica of one issue resolves the
  **same** key, sharing a transcript and contending for the store's one-writer lock.
  **The semantic dedup window still does its job**, and the distinction is the delicate part: the key
  gains `:r<i>` **only when a replica is set**, so re-deliveries of *each* replica still coalesce inside
  the 10-minute TTL, replicas never coalesce against *each other*, and an unflagged job's key is the same
  string it has always been. Distinct jobIds alone would not have been enough — duplicate `queue.add` under
  a taken id is *silently ignored*, so the second replica would simply vanish with no error surface.
  **Budget is untouched and that is the feature, not a gap.** N replicas make N honest reservations, each
  before its own tokens in its own processor (`CONST-BUDGET-BEFORE-TOKENS`), so the daily/weekly/monthly
  caps remain the ceiling and simply divide by N.
  **A named image must declare it.** `dev.pi-dispatch.capabilities` is checked pre-spend for replica jobs
  only; an image that does not name `replicas` is refused with `job-image-replicas-unsupported`
  (`INT-CONTAINER-RUNTIME-CONTRACT`).
  **There is deliberately no model-callable path to this field either.**
  `dispatch_trigger_add`/`_edit` carry no `replicas` parameter, for a sharper version of the reason they
  carry no `image` one: a spend multiplier is plainly a capability the model would *gain*. It is a file
  edit, and the panel displays it without offering a key that sets it.
- **`run.secrets` (ALL FOUR trigger kinds, optional map of env-var name to opaque reference) and
  `run.secretsProfile` (optional name)**: the environment variables this trigger's jobs receive, and which
  operator-declared resolver reads them. **The reference grammar is the resolver's, never this project's**
  (`REQ-TRIGGER-SECRETS`, `DES-PER-TRIGGER-SECRET-PROFILE`): the loader validates that keys are environment
  variable names and values are non-empty strings, and validates nothing about what a value MEANS.

  **Refused at load** for a key that is not an env-var name, a value that is empty, whitespace-padded or
  starts with `-` (the resolver's `argv[1]`, where a dash parses as a flag, exactly `run.image`'s reason),
  more than sixteen references (each is resolved sequentially before the container, holding a concurrency
  slot), a key colliding with a name the worker writes itself, a `secretsProfile` naming nothing, and
  `run.secrets` beside `run.resume: true` (a resumed job replays a transcript on host disk into every later
  job on that key, and nothing here redacts one).

  **A second and third refusal are pre-spend, not at load**, for `run.resume`'s reason: which profiles a
  deployment declares, which credential variables its provider uses, and what `PI_FORWARD_ENV` names are all
  deployment state, and the loader is pure and fs-free. Those refuse per delivery as
  `secret-profile-unknown`, `secret-profile-ambiguous`, `secret-name-reserved` and `secret-unresolved`, all
  with `budgetReserved: false`; a resolver that could not reach its manager is INFRASTRUCTURE and retries as
  `secret-resolver-unreachable`. `doctor` carries the load-time half.

  **Unlike `run.replicas`, this is legal on a `cron` trigger.** That refusal turns on a local `/workspace`
  being the operator's own folder with no clone, which is a fact about two agents sharing a working tree and
  not about a credential. The folder does bring its own hazard, and `doctor` warns about it.

  **There is deliberately no model-callable path to either field, and therefore no picker.**
  `dispatch_trigger_add`/`_edit` carry no `secrets` parameter, and no `secretsProfile` parameter either: a
  profile that resolves nothing is refused at load and no tool can write `run.secrets`, so a picker could
  never produce a valid trigger. The panel declares RESOLVERS, through the operator-typed `/dispatch
  secrets` command; binding one to a job stays an edit to this file.

- **`run.waitFor` (webhook kinds only, optional array of 1..4 one-key condition objects)**: the conditions
  that must ALL clear before this trigger's job starts (`REQ-WAIT-FOR`, issue #230). `{ "after": "<ISO
  instant>" }` is answered from the clock; `{ "profile": "<name>" }` is answered by an operator-declared
  executable (`INT-WAIT-PROFILES-CONTRACT`). Absent, the job data, container env and run record are
  byte-identical to one prepared before the field existed.

  **What is landed as of the grammar slice**: everything under "Refused at load" below, and the carry into
  job data. **The hold itself is not** — the pre-spend `wait-profile-unknown` refusal and the `doctor` half
  named below arrive with the enforcement slice of issue #230, and until then a trigger carrying this field
  loads, enqueues and RUNS. Said here rather than only in the revision row because this bullet, not the
  profiles entry, is what an operator authoring `triggers.json` is pointed at.

  **Refused at load** for: a non-array or empty array; more than four conditions (each `profile` is a
  subprocess run before the container, holding a concurrency slot, which is `run.secrets`' own bound in
  time rather than in count); a condition that is not an object naming EXACTLY ONE key; an `after` that
  does not carry its own zone, or names a date the calendar does not have; a second `after` in one array;
  a `profile` that is not a non-empty string, or is outside `ID_CHARSET`, or is named twice; and
  `exclusive`, by name, pointing at the mutex that replaced it.

  **An unknown key inside a condition is REFUSED, not dropped**, which inverts this file's posture for
  every other field and is the one place that inversion is right: elsewhere a dropped key is a field that
  does nothing, while here it is a TERM OF A GATE that does nothing, and the job runs. `on.disarmed`'s
  key sweep is the precedent; the difference is that this one guards a paid run rather than a sentinel.

  **Three combinations are refused at load**, each in `run.resume`'s *not yet covered* vocabulary because
  each is a gap with a known closure rather than a decision:
  - **`cron`**. The scheduler advances at PICKUP, so a held occurrence carries an older
    `repeat:<id>:<millis>` than the one the scheduler stores. Teardown deletes only the stored one, so a
    held job outlives both a trigger delete and the stall guard's money backstop and still pays; and a
    held occurrence's surviving job hash makes the next upsert a scheduler-id collision, which fails
    worker boot. Closing it needs delayed-set-aware teardown.
  - **`on.once`**. The one-shot disarm fires on EVERY run record, outcome-blind, so a wait that timed out
    would permanently spend a one-shot whose container never started, and `once-already-spent` would then
    refuse every retry until the operator hand-edited this file. Exempting the wait reasons instead would
    redefine "fired" for every other refusal too.
  - **`run.replicas`**. Fanout is at enqueue, so N replicas are N independent holds: N times the
    subprocesses and N times the contention for ONE external answer. `REPLICAS_MAX` was chosen against
    `PI_CONCURRENCY` on the premise that replicas RACE, and a hold inverts it.

  **A second refusal is pre-spend, not at load**, for `run.secretsProfile`'s reason: which profiles a
  deployment declares is env state and this loader is pure and fs-free. That refuses per delivery as
  `wait-profile-unknown`, and `doctor` carries the load-time half.

  **The field rides at JOB level and never inside `trigger`**, which here is a correctness requirement
  rather than the convention it is for `image`/`skillsDir`: `trigger` is copied VERBATIM into
  `/job/event.json`, so a `trigger.waitFor` would hand the agent the operator's own gate.

  **No model-callable path**, on `run.secrets`' reasoning: `dispatch_trigger_add`/`_edit` carry no
  `waitFor` parameter. A wait is reviewed trigger content, not a runtime control.

- **Why**: The operator's trigger set is one host file — diffable, reviewable, git-trackable — rather than
  two files in two shapes across two services. The schema unifies the *view*; evaluation still splits by
  owner (a `label` is never scheduled; a `cron` never receives a webhook). `on.id` (cron only) must be
  `:`-free because the stall guard parses BullMQ's `repeat:<id>:<millis>` job id by splitting on `:`.
  `run.task` is operator-authored natural language and therefore **DATA** (`CONST-ISSUE-TEXT-IS-DATA`): it
  lands in `/job/prompt.md`, never in a system prompt. `provider`/`model`/`maxTurns` are **pure
  passthrough**: omitted → absent from the emitted job data, resolved at job start via the overlay then env
  (`INT-CONFIG-OVERLAY-CONTRACT`). `image` is passthrough in the same sense with one deliberate difference:
  it resolves against `PI_JOB_IMAGE` **only**, never the settings overlay, so no admin-editable runtime knob
  can change which code every job executes (`DES-RUNTIME-SETTINGS-FILE-OVERLAY`). A `labeled` PR rule (like a `label` rule) requires a positive selector;
  at most one `comment` trigger may be configured.
- **Traces to**: `DES-TRIGGERS-UNIFIED-FILE`, `DES-CRON-VIA-BULLMQ-SCHEDULER`, `REQ-TRIGGER-AUTHOR-GATE`,
  `CONST-ISSUE-TEXT-IS-DATA`, `INT-CONFIG-OVERLAY-CONTRACT`, `INT-PI-PACKAGES-FILE-CONTRACT`,
  `REQ-GLOBAL-PI-OVERLAY`
- **Acceptance**: Given an off-diagonal entry (`cron`→`github`, or any webhook type→`local`), a duplicate
  cron `id`, a `:` in a cron `id`, a cron `run.folder` that does not exist, a `labeled` PR/label rule with
  no positive selector, or a second `comment` trigger, when the config loads, then load throws a
  `piDispatchConfig`-tagged error in both services. Given a valid `cron` entry, when it fires, then the
  emitted job's `data` byte-matches the interactive local (`enqueueLocalJob`) shape **plus exactly one
  cron-only field**: `trigger: { id, pattern }` — a scheduled job must be able to name its own trigger and
  pattern in `/job/event.json` (`INT-CONTAINER-JOB-INPUTS`), and `pattern` exists nowhere else at job time.
  The byte-match now additionally admits `packages` on the same terms as `github`: both stay **absent** when
  the trigger omits them (`undefined` drops out at JSON serialisation), so an unflagged trigger's `data` is
  byte-identical to the pre-`packages` shape and only a trigger that stated a value differs — which, under
  the opt-out polarity, is the trigger that switched packages **off**. Given a non-boolean `run.packages`
  on any of the four kinds, when the config loads, then both services throw. **The env carve-out is
  explicit**: with packages staged, a job that did **not** set `packages: false` carries `PI_PACKAGES`
  **and** — like every other job, opted out or not — `PI_OFFLINE=1`, so the container env is NOT
  byte-identical to the pre-issue one even for an unflagged trigger. That is a deliberate, stated exception in the same spirit as the cron
  `trigger: { id, pattern }` carve-out above, and for the same reason: it is a narrowing the whole fleet
  gets, not a per-trigger capability (`INT-CONTAINER-RUNTIME-CONTRACT`).
  The byte-match admits `image` on the same terms as `github` and `packages`: it stays **absent** when the
  trigger omits it (`undefined` drops out at JSON serialisation), so an unflagged trigger's `data` is
  byte-identical to the pre-`image` shape and only a trigger that named one differs. Given a `run.image`
  that is not a non-empty string, that carries surrounding whitespace, or that begins with `-`, on any of
  the four kinds, when the config loads, then **both services throw**. Given a `run.image` naming an image
  absent from the host, when the job is picked up, then it is refused **pre-spend** with reason
  `job-image-missing`, reserving no budget slot and minting no credential — and `--pull=never` means that
  tag could not have been fetched even had the check not run. **One scope correction to the env carve-out
  above**: the env the **worker passes** is identical for every image, but the env **baked into** an image
  is a fact about that image (*"facts about the image and not choices a job makes"*,
  `INT-CONTAINER-RUNTIME-CONTRACT`), so two triggers naming two images do not have identical container
  environments and never could. That is a property of the feature, not a defect, and it is stated here so
  nobody reads the byte-match clause as covering it.
  The byte-match admits `replicas` on the same terms: it stays **absent** when the trigger omits it, so an
  unflagged trigger's `data` **and its semantic dedup id** are byte-identical to the pre-`replicas` shape.
  Given `run.replicas` on a `cron` trigger, beside `run.resume: true`, or with a value that is not an
  integer in `2..3` (including `1` and `4`), when the config loads, then **every loader throws** — worker,
  receiver, and the admin console's bundled copy — and the message names the field and the reason. Given
  `run.replicas: 2` on a label trigger on ANY forge and one matching delivery, when the receiver accepts
  it, then **two** jobs are enqueued with that forge's own jobId prefix (`gh-`/`gl-`/`fj-`/`az-`) suffixed
  `-r1`/`-r2`, and dedup ids `repo<sep>n:flow:r1`/`:r2` composed with that forge's own separator, and a
  redelivery of that same GUID enqueues **nothing further**. Given a failure enqueueing replica *k*, then
  the receiver answers **503** with replicas `1..k-1` already queued — the retry converges on exactly *n*
  jobs, never more, because the queued ones dedup on their own now-taken ids.
  The byte-match admits `command` on `flow`'s own terms: a command trigger's `data` carries `command` and
  **no `flow` key at all** (never an empty one), and a flow trigger's `data` is byte-identical to the
  pre-`command` shape. Given an entry naming both `run.flow` and `run.command`, or neither, on any of the
  four kinds, when the config loads, then **both services throw** a `piDispatchConfig` error naming both
  fields. Given a `run.command` that is empty, leads with `/`, carries surrounding whitespace, or contains
  a control character, then both services throw. Given `run.task` beside a cron `run.command`,
  `run.instructions` beside a webhook `run.command`, or `run.resume: true` beside `run.command` on any
  kind, then both services throw. Given a comment delivery `@pi review` matching a command rule, then the
  enqueued job runs the rule's own command with the trailing word untouched as data — never a flow
  override, never a suppression.
  The byte-match admits `number` and `once` on `reviewState`'s terms: both stay **absent** when the rule
  omits them, so an unflagged trigger's normalized shape, job `data` and run record are byte-identical to
  the pre-#231 shape. Given `on.once` that is not a boolean, `once: true` without `on.number`, `on.number`
  that is not an integer >= 1, `once: true` beside `run.replicas`, a `pull_request` action list mixing the close
  word with any other action, a label predicate on an `issue` or close-only rule, any of the three fields
  on a `cron`/`label`/`comment`/non-close-`pull_request` entry, an `issue` entry naming `azure`, or a
  webhook `run.flow` outside the skill-name charset, when the config loads, then **every loader throws** —
  worker, receiver, and the admin console's bundled copy — naming the field. Given a three-entry file
  whose middle entry is disarmed, when it parses, then the result has **three** entries, the middle one is
  exactly the sentinel `{ on: { type: "disarmed" }, run: {} }`, and the third keeps its raw index in every
  consumer — the receiver's rule groups, the run-record join, and the panel. Given a disarmed entry whose
  `run` is malformed, then the whole file still refuses. Given `on.disarmed` that is not `{ at, jobId? }`
  with non-empty strings, carries an unknown key, or appears without `once: true`, then every loader
  throws.

## INT-PI-PACKAGES-FILE-CONTRACT

**operator → stager → worker + runner.** The operator declares which third-party pi packages exist; the
host-side stager materialises them into the global overlay and writes a receipt; the worker and `doctor`
read that receipt. Three consumers, one declaration, and the file the operator edits is never the file the
worker reads.

Since issue #102 this file is the **override-and-addition layer**, not the only source: `--with-packages`
also discovers what the operator installed with `pi install`, from pi's own `settings.json`, and stages it
at the exact version on disk. A declared entry still wins by name, so pinning older than the host runs stays
possible. `--no-host-packages` restores the declared-only behaviour exactly. Everything below applies
unchanged to a discovered entry: discovery adds **candidates, never exemptions**, and reaches this same
validator rather than a second copy of it.

- **Contract**:
  ```
  pi-packages.json  (path via `--packages-file <path>`, else PI_PACKAGES_FILE, else <cwd>/pi-packages.json;
                     read ONLY by `pi-dispatch import-pi --with-packages` — never at job time)
  { "packages": [
    { "name":    "<npm package name: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, <= 214 chars>",
      "version": "<EXACT: MAJOR.MINOR.PATCH[-prerelease][+build] — no range, tag, or wildcard>",
      "dir":     "<optional staged dir: /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9])?$/i, <= 64 chars,
                   unique across entries; default `@scope/name` -> `scope__name`>" } ] }
  ```
  Unknown fields are dropped, so consumers only ever read validated ones. Every rejection below is a
  fail-loud `configError` naming the offending package, raised **before a single directory is created**.
  - **Exact versions only.** `CONST-PI-VERSION-PINNED`'s reasoning applied to third-party code, not a new
    rule: a floating range turns a silent upstream minor into every queued job becoming a no-op **with no
    signal**, and the queue still reports success — the worst failure class available. Pinning converts
    that into an operator-visible edit of a version string. The refusal message states this in full,
    because it looks pedantic until you know the failure mode it prevents.
  - **Admin-like names are refused**, on both `name` and `dir` (`/pi-dispatch|dispatch-admin/i`) — the
    twin of the admin-extension block `import-pi` already enforces, for the same reason: a package that can
    enqueue paid jobs from **inside** a job container is a recursion vector.
  - **`dir` is a single path segment.** It becomes one component of a container path, so slashes, `..` and
    anything outside the charset are refused, length is checked **before** the charset (too long and bad
    characters are different operator mistakes deserving different fixes), and two packages may not share
    one `dir`.
  - **Staging** installs each package into a private `.staging-<i>` dir carrying its own root
    `package.json` — which pins npm's idea of "the project" to that dir so it cannot walk up into the
    operator's own checkout — via an **ARRAY argv**, never a shell string, because a name out of a config
    file must never become shell syntax on the operator's host:
    `npm install <name>@<version> --omit=dev --omit=peer --omit=optional --ignore-scripts
    --install-strategy=nested --no-audit --no-fund --loglevel=error`, run with **`cwd: <staging>`**.
    **The install target travels as the exec's `cwd`, not as `--prefix <staging>`, and that is a safety
    property rather than a style choice**: npm installs into the cwd's `node_modules` by default, so
    dropping the flag removes **the only filesystem path from argv**. What remains is literal flags this
    file spells out plus one `name@version` token whose halves were both validated before anything was
    created (`NPM_NAME_RE`, `EXACT_VERSION_RE` — neither admits a space, a quote, or a cmd
    metacharacter). That is exactly what makes `shell: true` safe on **win32**, where it is **required**:
    npm ships there as `npm.cmd`, and since Node 18.20.2 / 20.12.2 (CVE-2024-27980) spawning a
    `.cmd`/`.bat` without a shell throws `EINVAL` outright — and this package floors at Node >= 22.19, so
    every Node it can run on behaves that way. Non-win32 gets `cwd` alone and no shell.
    **Re-introducing a path into argv, or loosening either regex, invalidates that argument** and must be
    revisited together with the win32 branch.
    `--ignore-scripts` is load-bearing: without it the lifecycle scripts of this package **and of every
    transitive dependency** run **as the operator, on the operator's host**, at stage time.
    `--omit=peer` because pi resolves its own packages for an extension through a **jiti alias map** at
    load time, so a staged peer copy is ignored dead weight — and a floating pi version at that.
    `--omit=dev` and `--omit=optional` keep the staged tree to what a run actually imports.
    `--install-strategy=nested` asks npm to keep every dependency inside the package dir, and the result is
    **asserted rather than trusted**: the flag's name and default have moved across npm versions, so each
    declared `dependencies` key is checked to exist under the package's own `node_modules/`.
  - **Post-install assertions, all refusals**: `package.json` readable at `<staging>/node_modules/<name>`;
    its `version` **equals** the pin (npm reporting success is not evidence it staged what you asked for);
    every declared dependency present inside the package dir; a `pi` manifest **or** one of
    `extensions/`/`skills/`/`prompts/`/`themes/` present (a package contributing no pi resources loads as a
    silent no-op, and staging exists to turn that run-time nothing into a stage-time error); and no string
    anywhere in the `pi` manifest that leaves the package dir (a leading `/` or `\`, or a `..` segment) —
    manifest entries resolve relative to the package dir at job time, so one that climbs out would reach
    the rest of the read-only overlay.
  - **Warn, do not refuse**: a package declaring `scripts.install|preinstall|postinstall` or
    `optionalDependencies` is staged **INCOMPLETE** — the build step did not run and the optional
    dependency was not fetched — and may fail at run time. Stated at stage time rather than discovered
    mid-job.
  - **All-or-nothing.** Every package is installed and asserted in its staging dir; only once **all** have
    passed is each `renameSync`d into `<overlay>/packages/<dir>/`. A failure rolls back the renames and the
    staging dirs and removes a `packages/` root it created. A half-staged set is worse than none, because
    pi would load the packages that made it and silently skip the rest. (`renameSync`, never a copy: the
    copy helper's symlink guard uses `statSync`, which **follows** links, so it would copy the target of
    every `node_modules/.bin` symlink instead of skipping it.)
  - **Staged layout and the receipt**:
    ```
    <PI_GLOBAL_PI_DIR>/packages/<dir>/package.json        the package, self-contained
    <PI_GLOBAL_PI_DIR>/packages/<dir>/node_modules/**     its OWN deps — no install, no registry fetch at job time
    <PI_GLOBAL_PI_DIR>/packages/packages.json             the stage manifest (the receipt)
    { "stagedAt": "<ISO-8601>",
      "packages": [ { "name", "version", "dir", "from": "pi-packages" | "host" } ] }
    ```
    `packages.json` is **the read model** for everything downstream: the worker turns it into container
    paths `/opt/pi-global/packages/<dir>` (built with template literals, never `path.join` — the worker may
    run on Windows and these are Linux container paths), and `doctor` and the admin panel read it to show
    what is staged. Reading it **NEVER throws**: it runs on the job path, where a corrupt or half-written
    manifest must degrade to "no staged packages" rather than crash the worker mid-queue, and its entries
    are **re-validated on the way in** because the file is a host artifact an operator may have hand-edited
    between stage time and job time.
    `from` is provenance (issue #102): `"pi-packages"` for an entry the operator declared, `"host"` for one
    discovered in their pi setup. It is a **CLOSED enum with a default, never a pass-through** — anything
    that is not exactly `"host"` reads as `"pi-packages"`, so a hand-edited receipt cannot inject a string
    that reaches a printed `doctor` line. Both compatibility directions are covered by that one rule: a
    receipt written before #102 carries no `from` and correctly reads as declared, and an older worker
    reading a newer receipt drops the field like any other unknown key. The receipt deliberately records
    **no install path** — it is bind-mounted into every job container, and provenance is the fact `doctor`
    needs while a path off the operator's machine is not.
    The receipt is re-read **at each job start**, not once at boot (changed in issue #102). The original
    boot read was right while the staged set only changed when the operator edited a reviewed file;
    discovery makes `pi install` then re-stage a routine act, and under a boot read a re-stage that DROPS a
    package makes every subsequent job refuse at container start (exit `2`) with budget already reserved,
    burning a daily-cap slot until someone restarts the worker. A failed read keeps the **last known good**
    set and logs, never degrading to none: an empty set emits no `PI_PACKAGES` at all, so the runner's
    path assertion would have nothing to refuse and the job would run without its tools and still exit `0`.
- **Why**: Two directions, two error policies, and the split is the whole point. `pi-packages.json` is the
  **operator's** declaration, read once, on the host, by an interactive command — so it fails **loud** and
  names the offending package. `packages.json` is the **stager's receipt**, read on the money path by a
  long-running worker — so it fails **quiet** and degrades to nothing staged. Inverting either would be
  wrong in the expensive direction: a loud job-path read turns one bad byte into a stalled queue, and a
  quiet stage-time read silently ships an unpinned or admin-shaped package into every job container.
  Staging on the **host** rather than resolving `npm:` in-container is what lets a job load third-party
  extensions with no job-time install and `PI_OFFLINE=1` set (`INT-CONTAINER-RUNTIME-CONTRACT`): pi treats any
  spec that is not `npm:`/`git:`/a URL as a **local path** and resolves it in place — no install, no
  network, no writes.
- **Traces to**: `REQ-GLOBAL-PI-OVERLAY`, `CONST-PI-VERSION-PINNED`, `DES-OPERATOR-GLOBAL-OVERLAY`,
  `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-CONTAINER-JOB-INPUTS`
- **Acceptance**: Given a ranged version, an admin-like `name` or `dir`, a `dir` that is not a plain
  segment or is duplicated, a name outside the npm charset, a package whose staged `version` differs from
  the pin, a dependency npm hoisted out of the package dir, a package with neither a `pi` manifest nor a
  resource dir, or a manifest string with a leading separator or a `..` segment, when
  `import-pi --with-packages` runs, then it refuses, says which package and why, and **nothing is staged**;
  given a package declaring lifecycle scripts or `optionalDependencies`, then it stages with a printed
  INCOMPLETE warning; given a successful stage, then `<overlay>/packages/packages.json` lists exactly the
  declared `{name, version, dir}` triples and each `dir` exists beside it; given a missing, unreadable, or
  garbage `packages.json` at job time, then the worker reads it as **no staged packages** and never throws.

## INT-RUN-HISTORY-FILE-CONTRACT

**worker → admin extension.**

- **Contract**:
  ```
  <logsDir>/<sanitizedJobId>.log      append-only container stdout+stderr; untrusted, PII-bearing; written ONLY when PI_CAPTURE_JOB_LOGS=1
  <logsDir>/<sanitizedJobId>.json     one JSON object, PII-free, overwritten on each terminal state (last-write-wins across retries)
  (logsDir via PI_LOGS_DIR; empty/unset = <OS temp>/pi-dispatch/logs)
  { "jobId":   "<raw job id: delivery id | local-<hex> | repeat:<sched>:<millis>>",
    "kind":    "github" | "gitlab" | "local" | null,
    "target":  "<repo>#<issue>"  |  "<project>!<iid>"  |  "local:<basename>" | null,
    "flow":    "<flow name>" | null,
    "startedAt": "<ISO-8601>", "endedAt": "<ISO-8601>",
    "outcome":   "completed" | "policy" | "failed",
    "reason":    "<fixed enum: worker-abort|over-budget|unprotected-branch|runner-policy|container-never-started|settings-overlay-invalid|job-image-missing|job-image-replicas-unsupported|job-image-forge-unsupported|job-image-commands-unsupported|once-already-spent|scope-cap|wait-skew|wait-unreadable|wait-profile-unknown|wait-superseded|wait-after-beyond-max|wait-refused|wait-unanswerable|wait-expired|daily-token-cap|soft-hold|sessions-dir-unset|secret-profile-unknown|secret-profile-ambiguous|secret-name-reserved|secret-unresolved|secret-resolver-unreachable|sha-gone|pi-too-many-files|pi-file-too-large|pi-too-large|pi-path-collision|skills-dir-missing|skills-dir-empty|skills-dir-too-large|skills-dir-too-many-files|skills-dir-too-deep|skills-dir-unreadable|egress-proxy-missing|egress-proxy-stopped|...>" | null,
    "exitCode":  <int> | null,
    "turns":     <int> | null,
    "tokens":    { "input": <int>, "output": <int>, "total": <int>, "cost": <number>,          // per-job usage totals; null when the container died before the exit line
                   "metered": <bool>,                                                          // true = process-wide meter; false = the subscribe() fallback (then the keys below are absent)
                   "rootTotal": <int>, "otherTotal": <int>, "looseTotal": <int>,                // attribution split; sums to `total`
                   "sessions": <int>, "calls": <int>, "unresolved": <int>, "unpriced": <int> } | null,
    "usage":     { "v": <int>,                                                                  // ledger block version; readers treat an unknown v as opaque-but-present
                   "piAi": "<major.minor.patch>" | null,                                        // the pi-ai the meter priced with, read from the resolved package at install; a rates PROVENANCE stamp
                   "truncated": <int>,                                                          // named rows folded into the "other" row at the 8-row cap; 0 = none
                   "models": [ { "provider": "<id>", "model": "<id>",                           // lowercased, host-validated ^[a-z0-9][a-z0-9._:/-]{0,63}$
                                 "calls": <int>, "input": <int>, "output": <int>,
                                 "cacheRead": <int>, "cacheWrite": <int>, "cacheWrite1h": <int>,
                                 "reasoning": <int>, "total": <int>,                            // billed total, same convention as tokens.total; rows sum to it
                                 "cost": <number>, "unpriced": <int> } ] } | null,              // null: fallback meter, pre-ledger runner, died before exit line, or malformed
    "provider":  "<host-effective provider>" | null,                                            // what the HOST dispatched with (job.data > overlay > env), never a container string
    "model":     "<host-effective model id>" | null,
    "budgetReserved": <bool> | null,
    "attempt":   <int>,
    "parentJobId": "<job id: same id-space as jobId>" | null,
    "chainDepth":  <int> | null,
    "chainRefused": <int> | null,   // count of chain requests refused on this parent; 0 = none
    "replica":  <int> | null,       // this job's 1-based index within its replica set; null = an ordinary run
    "replicas": <int> | null,       // the set size, so `r2` is legible without finding the sibling row
    "triggerIndex": <int> | null,   // raw triggers-array index of the entry that fired (cron entries counted); forge jobs only
    "triggerType": "label" | "comment" | "pull_request" | "issue" | null,   // that entry's on.type; null on cron, chained, and manual jobs
    "session": { "resumed": <bool>,                                                             // what pi ACTUALLY did
                 "reason": "<fixed enum: resumed|absent|expired|conversation-too-old|resume-chain-too-long|context-too-full|too-large|unparseable|not-a-regular-file|pi-version-changed|locked|promote-failed|disabled>" | null,
                 "bytes": <int> | null } | null }   // null when the job had no session at all
  ```
  Field order is the serialisation order (`JSON.stringify` emits insertion order). The filename uses the
  **sanitized** id (`:` → `_`, because `repeat:<sched>:<millis>` is NTFS-illegal); the record **body**
  keeps the raw `jobId`. `reason` is a fixed enum passed through from the terminal outcome — never
  free-form and never payload text — and `turns` is `null` when the container died before emitting the
  runner `exit` line.

  `session.reason` reads as one flat list but has **three producers**, which is why a token can look
  unreachable from whichever half of the code you happen to be in. The enum has always been documented
  CLOSED here, and since the v1.6.1 correction it is **checked** at the one place the container's copy is
  admitted (`parseExitSession` against `SESSION_REASONS`): an unrecognised token reads as `null` rather
  than riding through. Before that check, the runner's half was an unvalidated string, so the container
  could write any value into a record whose PII-free property rests on holding none — while this file
  called the set closed and the code's own comment called it "a boolean and a fixed enum". A list that
  lives anywhere but the admission point is a comment, not a check.

  | Producer | Tokens |
  |---|---|
  | **resolve path**, host-side, before the container (`readCanonical`) | `resumed`, `absent`, `expired`, `conversation-too-old`, `resume-chain-too-long`, `context-too-full`, `too-large`, `unparseable`, `not-a-regular-file`, `pi-version-changed` |
  | **runner**, in the container (`image/runner/src/session.mjs`) | `disabled` (every unarmed job), `resumed`, `absent`, `unparseable` |
  | **promote path**, only on a `completed` exit (`promoteSession`) | `absent`, `not-a-regular-file`, `too-large`, `locked`, `promote-failed` |

  Precedence has **two** rules, and for the feature's first year this entry recorded only the first.
  A refused promotion **wins** over the other two (`mergeSession`, `worker/src/processor.mjs`): on a
  completed run it is the more useful reason, because it says why the NEXT run for this key will cold
  start. Then **a resolve-path gate that REFUSED outranks the runner's `absent`**, and without that rule
  `expired` and `pi-version-changed` were unreachable in any record whose container emitted an exit line —
  which is every ordinary run. The mechanism is not obvious from either half of the code: a refused read
  stages a **0-byte** file rather than nothing (`INT-SESSION-STORE-CONTRACT`, where the reasoning is pi's
  EEXIST race), `PI_SESSION_FILE` is emitted whenever a session exists at all rather than only when it
  resumes, and pi's `setSessionFile` gates its own refusal on `size > 0` — so the container opens the
  empty file successfully, finds no messages, and reports `absent` on EVERY host refusal. That token is a
  restatement of the question, not an answer to it. The rule is deliberately narrow, `resume === false`
  on the host side and exactly `absent` on the runner's: a host that DID stage a transcript while the
  runner reports `absent` is the disagreement this object exists to show, and the runner's `unparseable`
  reports a degrade the host could not see. Three further things follow that the list cannot show. `expired` never arrives from the promote path,
  which checks the file but not the TTL. `promoted` is a `promoteSession` return value that reaches no
  record, because the merge reads a promotion's reason only when it refused. And `promote-failed` is the
  one an operator meets in the wild: a full disk or a permissions change mid-promotion produces it.
  `promoteSession`'s remaining return, `no-key`, is deliberately **absent from this enum** and cannot
  reach a record — it is a DI-seam backstop, unreachable in a wired worker for the same reason the
  store's own no-`sessionsDir` return is, since `sessionKeyFor` is total and binary and `resolveSession`
  therefore returns `null` rather than a keyless session.
- **Why**: The admin extension is a separate process (`DES-ADMIN-VIA-PI-EXTENSION`) that reads this as a
  read-model it does not share memory with — the worker writes the files, the admin extension reads them, and
  nothing crosses in RAM. The worker writes on both terminal paths: `worker/src/index.mjs` `makeProcessor`
  calls `recordRun` on the success (`result`) and the failure (`error`) branch alike, and
  `worker/src/run-history.mjs` `makeRecordWriter` serialises the record with a truncating
  `fs.writeFileSync`, so a re-run of the same id overwrites — last-write-wins across retries. The `.json`
  is PII-free **by construction**: `buildRecord` (`worker/src/run-history.mjs`) is an explicit object
  literal over stable id-only fields and never spreads `job.data`, `result`, or `error`, so a GitHub
  job's title/body and a local job's `task` or full folder path cannot leak — `target` keeps only
  `repo#issue` or the folder `basename` (`no-pii-in-logs`, `REQ-LOCAL-JOB-VISIBILITY`). The `.log` is a
  **separate file** from the `.json` precisely so the untrusted, PII-bearing container stream — teed off
  each stdout/stderr chunk by the sink in `worker/src/run-container.mjs` — never contaminates the
  structured record; it is opt-in, host-side (never mounted into the container), and written only under
  `PI_CAPTURE_JOB_LOGS=1`. This is a **flat per-job file, not a database**: one `.json` (plus the optional
  `.log`) keyed by the sanitized job id, no schema and no query surface — upholding this file's standing
  invariant that **there is deliberately no database**. The files now also double as the `previousRunAt`
  source for scheduled jobs (`INT-CONTAINER-JOB-INPUTS`): a read-only, filename-keyed scan for the prior
  fire's `repeat_<id>_<millis>.json` — explicitly NOT a query surface — and retention
  (`PI_LOG_RETENTION_DAYS`) naturally bounds how far back the lookup sees. The chain fields — `parentJobId`,
  `chainDepth`, `chainRefused` — are **additive and nullable**, set as explicit literals by the same no-spread
  `buildRecord` (a chained job carries its parent id and host-computed depth; `chainRefused` records how many
  of a parent's own `/outbox` requests were refused). `chainRefused` is an **`<int>` count, not a boolean** —
  the collector returns a running `refused` count, and the record stores it verbatim (`0` = none), so the runs
  view can surface "2 refused" rather than a bare yes/no. The `reason` enum is **untouched**: a chain refusal is
  **pre-enqueue of the child**, so there is no child record and no new terminal reason — `chainRefused` is
  a separate count on the **parent**, never an enum value. The replica fields — `replica`, `replicas`
  (`REQ-REPLICA-RUNS`) — are **additive and nullable on the chain fields' precedent**, explicit literals
  read from the job's own `data` by the same no-spread `buildRecord`. They may be here at all because they
  are **integers**: this record's PII-free-by-construction property rests on it holding no attacker-chosen
  string, and a host-assigned index is not one. The **branch name they imply is deliberately absent**, for
  the same reason `session` omits its key and branch. Without these two fields, two records on one target
  read as an accidental double-run rather than as the pair an operator asked for. The trigger-attribution
  fields — `triggerIndex`, `triggerType` — are **additive and nullable on the replica fields' precedent**,
  explicit literals read from the job's own `data.trigger.matched` by the same no-spread `buildRecord`.
  They persist the receiver's harness-computed decision record (`INT-CONTAINER-JOB-INPUTS`):
  `triggerIndex` is the raw `triggers.json` array position of the entry that fired (cron entries counted —
  the file index is the rule's identity), `triggerType` that entry's `on.type`. An **integer and a fixed
  enum are the same admissible class as `replica` and `session.reason`**; the third `matched` key
  (`label`/`phrase`/`action`) is **deliberately absent**, because a label that satisfied an `any`
  predicate is collaborator-applied payload text, and persisting it would put an attacker-adjacent string
  in a record whose PII-free property rests on holding none. Without these two fields a forge run joins to
  its trigger only by the flow-name heuristic, which two triggers naming one flow defeat — the exact
  ambiguity `matched` was minted to remove (issue #49; persisting it was deferred there by that issue's
  no-new-record-fields scope, not by this record's posture). **Cron records hold `null` for both on
  purpose**: a cron job's `data.trigger` is `{ id, pattern }` with no `matched`, and its attribution is
  already exact via the `repeat:<id>:<millis>` jobId join (above) — a join that also reaches records
  written before these fields existed, where a new field cannot. The `tokens` field is **additive and nullable**
  in exactly the same way — an explicit no-spread literal of the runner's per-job usage totals
  (`REQ-TOKEN-ACCOUNTING-AND-CAPS`), or `null` when the container died before emitting the runner `exit`
  line. It is PII-free by construction: integer token counts and a numeric cost only, no
  payload text — and since the v1.6.1 correction that property is **enforced rather than intended**.
  `parseExitTokens` REBUILDS the admitted object from a closed twelve-key list (the union of the metered
  snapshot and the token-budget fallback, in the runner's own emission order, so a conformant object
  round-trips byte-identically) instead of returning the container's object as it arrived. It had been
  returned verbatim whenever `total` was numeric, so any key the container invented rode into the record:
  the PII-free property held at `buildRecord`'s literal and NOT one level below it, which is exactly the
  gap `usage` had already been given `parseExitUsage`'s rebuild to close. A key the runner omitted stays
  OMITTED rather than becoming null, because the fallback shape legitimately carries five of the twelve
  and a null would read as a measured zero.
  It is read-only telemetry recovered from the exit line (`parseExitTokens`) exactly as
  `turns` is, and like `turns` it never feeds exit-code or retry classification (`INT-RUNNER-EXIT-CODE-PROTOCOL`).
  **All five exit-line parsers repair a GLUED line before skipping it (issue #224).** A partial write
  from anything sharing the container's stdout lands as `<stray bytes><runner line>` in ONE line; a
  reader that merely skipped it lost `turns`, `tokens`, `usage`, `session` and `context` at once -- or
  handed the backward scan to a forged exit line placed earlier, with no race to win. The repair
  re-anchors on the runner writers' own first-key bytes (`{"event":"`) and takes the leftmost complete
  object: JSON.stringify escapes every quote inside a string value so those raw bytes cannot occur mid-
  line, and the left-to-right scan is what makes the outer object win over any nested one. The writers
  themselves newline-DELIMIT since the same issue, and both edges ship because only the reader's reaches
  logs an older image already wrote. A line truncated at the END parses to nothing and stays skipped;
  one truncated at the HEAD is skipped when no anchor survives the cut and correctly repaired when the
  cut fell in a glued line's stray prefix -- either way a fragment is never misread as a value. A
  repaired value remains read-only telemetry -- classification stays the container exit code's job.
  **The process-wide meter widened the object, not the contract.** `tokens` grew `metered`, the
  `rootTotal`/`otherTotal`/`looseTotal` split, and the `sessions`/`calls`/`unresolved`/`unpriced` counters
  — additive inside an already-additive field, and still **nullable as a whole** (a container that died
  before the exit line still records `tokens: null`, not a partial). `parseExitTokens` is **unchanged**: it
  scans from the end for the last `exit` event and accepts any object with a numeric `total`, so it parsed
  both shapes on the day the meter landed and needs no version negotiation. `buildRecord` is unchanged for
  the same reason — it stores `source.tokens` verbatim, so the widened object rides through with no new
  field to forget. What **did** change is the meaning of the number `recordTokenSpend` charges to the daily
  counter: it is now **process-wide** spend, including in-process subagent sessions and the
  compaction/summarisation calls that never surfaced as a root `turn_end`, so at identical real spend the
  counter fills faster than it used to. That is the correction the meter exists for, and `metered` is what
  lets a reader tell a corrected total from a legacy one.
  The `usage` ledger is a **SIBLING of `tokens`, not a widening of it** — and the reason is the same one
  that made `parseExitSession` a sibling. `tokens` rides through `parseExitTokens` verbatim only because it
  holds nothing but numbers; the ledger carries `provider`/`model` **strings emitted by the container**,
  which makes them attacker-adjacent, so `parseExitUsage` REBUILDS a narrowed, validated object and never
  passes one through: ids are lowercased and must match `^[a-z0-9][a-z0-9._:/-]{0,63}$`, every numeric must
  be finite and non-negative, and **any violation nulls the whole block, never a partial** (the same
  malformed→null rule `tokens` has). Widening `tokens` instead would have traded that validation away for
  parser convenience — the one trade this record cannot make. The block is bounded by construction: at most
  **8 named rows** (top by billed total) plus one `{provider:"other", model:"other"}` row that numerically
  absorbs both the overflow (counted by `truncated`) and any call observed without model context — a call
  is **never guessed onto a model**. The fold is numeric, so `Σ models[].total === tokens.total` still
  holds; that sum is the **emitter's** invariant, asserted in the runner's meter tests — the host validates
  fields, not bookkeeping. `piAi` stamps which pinned rate tables priced the run, so history is **priced
  once and never silently repriced** — a later pin bump shows up as a visible provenance difference on new
  records, not a rewrite of old ones. The sibling `provider`/`model` fields are **host-effective dispatch
  facts** (`job.data > overlay > env`, resolved by `effectiveSettings`), threaded through every terminal
  result and error object — including `InfraRetry` — precisely so a catch-path or pre-exit-line death
  still attributes to the model the host dispatched; they are operator-side strings on the `flow`
  precedent, never container output. A `usage: null` beside a real `tokens` object is **normal, not an
  error**: the fallback meter, a pre-ledger runner image, and a mid-run death all produce it, and readers
  degrade to the flat totals exactly as pre-meter readers degraded to `turns`. Like `tokens`, the ledger is
  read-only telemetry and never feeds exit-code or retry classification (`INT-RUNNER-EXIT-CODE-PROTOCOL`).
  The `session` field is **additive and nullable** in exactly the way `tokens` and the chain fields are —
  an explicit no-spread literal, `null` for every job that had no session. It merges the host's intent
  with the container's report, because either alone lies: the host knows whether a key resolved and which
  gate refused, and only the container knows what pi did with the file it was handed, so a host that
  staged a transcript while the runner reports `resumed: false` is a real event (a corrupt file, a
  degrade) that one number alone cannot distinguish from an ordinary cold start. **The key and the branch
  name are deliberately ABSENT**: this record's PII-free-by-construction property rests on it holding no
  attacker-chosen string, and a branch name is exactly that. A boolean, a fixed enum and an integer are
  the same class as `turns` and `chainRefused`.
- **Traces to**: `REQ-DURABLE-RUN-HISTORY`, `REQ-LOCAL-JOB-VISIBILITY`, `INT-RUNNER-EXIT-CODE-PROTOCOL`, `REQ-TOKEN-ACCOUNTING-AND-CAPS`, `REQ-RESUMABLE-SESSION`
- **Acceptance**: Given a job reaching a terminal state, exactly one `.json` keyed by its sanitized job
  id exists; its `outcome` matches the queue outcome (`completed` / `policy` / `failed`); no field carries
  issue or comment body text (`target` is `repo#issue` / `local:<basename>` only); `turns` is `null` when
  the container died before emitting the runner `exit` line; the `.log` exists only when
  `PI_CAPTURE_JOB_LOGS` is set. Given a metered run, `usage.models` carries only lowercased,
  charset-validated ids and its rows sum to `tokens.total`; given a usage block violating any field rule,
  the record stores `usage: null`, never a partial; given a catch-path or pre-exit-line death,
  `provider`/`model` still carry the host-effective dispatch values; given a fallback-metered
  (`metered: false`) or pre-ledger run, `usage` is `null` and no reader treats that as an error. Given a
  forge job whose data carries `trigger.matched`, the record holds `triggerIndex` and `triggerType` —
  index `0` persists as `0`, never as `null` — and neither field ever carries the matched
  `label`/`phrase`/`action`; given a cron, chained, or manual job, both are `null`.

## INT-OUTBOX-CONTRACT

**container (agent) → worker.**

- **Contract**: A **local** job mounts a read-write `/outbox` (a **github** job does not). The agent
  requests follow-up flows by writing `request-<n>.json`, `n = 1..PI_CHAIN_MAX_PER_JOB`:
  ```
  /outbox/request-<n>.json    n = 1..PI_CHAIN_MAX_PER_JOB; each file <= 4 KiB
  { "flow": "<skill-charset flow name>",   // required
    "task": "<freeform text>" }            // optional -- DATA, lands in the child's prompt.md
  ```
  The `folder` field is **ignored** — the child folder is forced to the parent's own folder, so this slice
  is **same-folder-only**. Unknown keys are ignored, with ONE read-and-refused exception (issue #189): a
  request carrying a **`command`** key — any value, even beside a valid `flow` — is refused outright as
  **`chain-command-refused`**, before the flow-name charset check and with no opt-in. Chaining is
  flow-only by construction: a command prompt is BUILT at the two host-side producers rather than read
  from any committed artifact, so there is nothing a default-deny gate could consult
  (`DES-AI-TRIGGER-FLOW-GATE` reads frontmatter, and a command has none), and silently ignoring the key
  under the unknown-keys rule would enqueue a flow the agent did not request — the believed-on-while-off
  shape. Commands may chain OUT — a local command job keeps its `/outbox`, its requests naming flows
  under the same gate — but nothing chains INTO a command. `task` is agent-authored **DATA**
  (`CONST-ISSUE-TEXT-IS-DATA`, one layer down): it becomes the child's `/job/prompt.md` user prompt and
  **never** enters the run-history `.json` record.
- **Validation order** (host-side, fail-closed at the first miss): count cap (`PI_CHAIN_MAX_PER_JOB`) →
  per-file size cap (4 KiB) → regular-file-only (a symlink, directory, or device is rejected) → JSON
  parse → `command`-key refusal (`chain-command-refused`) → flow-name charset (the skill charset) → depth
  cap (host-computed `parent.chainDepth + 1` against
  `PI_CHAIN_DEPTH_MAX`, **never** read from the outbox) → `ai-trigger` gate at the **parent's pre-agent
  SHA** (`DES-AI-TRIGGER-FLOW-GATE`) → enqueue.
- **Retry-idempotent child id**: `parent id + content-hash(flow, task)`, so a retried parent re-enqueues
  **identical** ids that BullMQ dedups — a retry cannot fan out duplicate follow-ups.
- **Completed-only collection**: `/outbox` is read **only** after a completed container exit; a policy or
  infra-thrown parent spawns nothing. A **github** parent has **no `/outbox` mount at all** — the request
  channel does not exist for it, so an untrusted issue author cannot chain.
- **Ro shadow**: the agent can re-read its own requests via the `/job:ro` tree (`/job/outbox/…`) —
  harmless, since the file is agent-authored and the worker trusts nothing in it.
- **Why**: The `/outbox` file is the container's only signal channel back to the host and is **untrusted**;
  every field is allowlist-validated host-side before an enqueue, the child folder is forced, and depth is
  host-computed, so a queue-blind container can neither forge a shallow chain to evade the cap nor escape
  same-folder scope. Keeping `task` out of the `.json` preserves the record's PII-free-by-construction
  guarantee (`INT-RUN-HISTORY-FILE-CONTRACT`), and enqueued children pass `reserveBudget` consumer-side
  like any local job (`CONST-BUDGET-BEFORE-TOKENS`).
- **Traces to**: `DES-JOB-OUTBOX-CHAINING`, `DES-AI-TRIGGER-FLOW-GATE`, `CONST-ISSUE-TEXT-IS-DATA`,
  `CONST-BUDGET-BEFORE-TOKENS`, `INT-RUN-HISTORY-FILE-CONTRACT`, `DES-COMMAND-ENTRY-POINT`, `OQ-022`
- **Acceptance**: Given a completed local parent with a valid `request-1.json`, when the worker collects
  `/outbox`, then exactly one child is enqueued on the parent's own folder with `chainDepth = parent + 1`;
  given a request over the count or depth cap, or whose flow fails the `ai-trigger` gate, when collected,
  then it is refused and no child is enqueued; given a request carrying a `command` key, when validated,
  then it is refused as `chain-command-refused` before any charset or gate read and no child is enqueued;
  given a **github** parent, when it exits, then no `/outbox`
  exists to collect; given a symlink or an oversize `request-<n>.json`, when validated, then it is
  rejected; given a **retried** parent, when its outbox is re-collected, then the idempotent child id
  dedups and no second child is enqueued.

## INT-SESSION-STORE-CONTRACT

**worker <-> host store <-> container.**

- **Contract**:
  ```
  <PI_SESSIONS_DIR>/<key>/current.jsonl   canonical transcript; mode 0700; NEVER bind-mounted
  <PI_SESSIONS_DIR>/<key>/pi-version      the pi version that wrote it
  <PI_SESSIONS_DIR>/<key>/resume-chain    consecutive resumed completions on this key; maintained unconditionally
  <PI_SESSIONS_DIR>/<key>/context         `<tokens> <window> <model>` as last measured; cleared by a cold start
  <PI_SESSIONS_DIR>/<key>/lock            exclusive-create promotion lock; absent when free
  <jobDir>/session/current.jsonl          this job's OWN copy; mounted /session:rw
  PI_SESSION_FILE=/session/current.jsonl  emitted ONLY when the job has a transcript; never empty
  ```
  `key` is `sha256(kind \0 repo \0 ref)` truncated — a hash, not a path built from a branch.
  `PI_SESSIONS_DIR` has **no default**; unset means the feature is unavailable.
- **Read path**, host-side, fail-open at the first miss, every miss a named cold start: key resolves ->
  canonical file exists -> **`lstat` says regular file, not a symlink** -> size <= `PI_SESSION_MAX_BYTES`
  -> mtime within `PI_SESSIONS_TTL_DAYS` -> stamped `pi-version` matches the job image's label ->
  `resume-chain` below `PI_SESSION_MAX_RESUME_CHAIN` -> stored `context` occupancy below
  `PI_SESSION_MAX_CONTEXT_PCT` -> first parsed line is a `{"type":"session"}` header
  -> that header's `timestamp` is within `PI_SESSION_MAX_AGE_DAYS` -> copy into the per-job dir. A cold start stages a **0-byte file** rather
  than nothing. The order is the contract, not an implementation detail, because the first miss is the one
  that names itself: the shape check stays AHEAD of the age bound so a damaged transcript reads as
  `unparseable` rather than as a lineage that aged out, and the age bound is the only arm that reads
  anything from the header beyond its `type`. The chain bound sits BEHIND `pi-version` and AHEAD of the
  header read, because it is a sidecar read like `pi-version` and because it is the one arm that asks
  about the lineage rather than the file, so refusing on it need not pull a transcript that may be
  megabytes. What that costs is stated rather than left to be found: a transcript both chain-exhausted and
  corrupt reports the chain, and the corruption is deferred by exactly one run, since that cold start's own
  promotion resets the counter.
- **The chain counter**: an integer file beside the transcript, written immediately after the swap and
  under the same promotion lock, so it can never describe a transcript older than the one now in place.
  **It counts the HOST'S DELIVERIES**, incremented whenever the host handed this key's transcript to a
  container and reset to `0` when it did not. That is a correction, and the reason it matters is the whole
  security of this bound: it counted the CONTAINER's `resumed` first, on the reasoning that a transcript pi
  declined to continue extended nothing. The agent owns `/session`, so it chooses what pi makes of the
  file, and a transcript carrying a valid header with its payload on lines pi's parser DROPS is delivered
  every run while pi reports zero messages -- so the counter reset every run and the bound never fired.
  Measured against the pinned pi, not reasoned about. The host's own decision to hand the file over is the
  one fact in this exchange that nothing inside the container can influence, and it is what this counts.
  **Maintained whether or not a bound is set**, because a counter that starts when the knob does is a bound
  that does nothing for its first N runs, and an operator setting `3` against a lineage already forty deep
  would get no refusal at all. **A missing or unreadable counter is a chain of zero**, the opposite polarity
  to the age bound and deliberately: every key predating the file has none, and reading absence as
  exhaustion would cold-start an entire store the day the bound was set. **The reset needs a COMPLETED
  run**: only a completed exit promotes, so a lineage whose runs keep failing stays cold rather than
  resuming, which is the safe direction and the one an operator should expect.
- **The context sidecar**: `<tokens> <window> <provider>/<model>`, written under the same lock immediately
  after the swap, from the reading the container reported on its exit line
  (`INT-RUNNER-EXIT-CODE-PROTOCOL`). Both numbers rather than a precomputed percentage, so a refusal can be
  read against what it was judged by, and **the model stamped beside them because a key carries none**: a
  key is `(kind, repo, ref)`, two triggers on one issue may name different models, and the same token count
  is 78% of a 32k window and 2.5% of a 1M one. A reading stamped with a DIFFERENT model is not a reading
  about this one and is ignored; unknown on either side stays usable, so a deployment that names no model
  per trigger keeps the bound it had. **A run that RESUMED and measured nothing leaves the previous reading
  in place**, since the transcript it promoted is the old one extended and the last real measurement is the
  closest true statement available -- a zero would read as "the context emptied", which cannot have
  happened. **A COLD START CLEARS it**, and that is a correction: keeping it there turned one high reading
  into a key that refused itself forever, because the gate cold-started on a stale number and the cold
  start left the same number behind for the next run to read. Nothing released it either, since every
  promotion refreshes the transcript's mtime and neither the TTL gate nor the reaper can reach an actively
  used key. **Anything not readable as two positive integers is NO MEASUREMENT**, and the gate passes on no
  measurement rather than guessing. The rejected fallback is on the record: `bytes` against the model's
  `contextWindow` needs a bytes-to-tokens calibration this project does not have, and `bytes` is the whole
  branch INCLUDING what compaction folded away, so it over-reads exactly past the threshold the bound
  exists for -- it would fire hardest on the sessions that had just become safe. **The number is
  container-reported**, at the same trust level as `turns` and `tokens`; the residual is `OQ-003`.
- **Every read in a key directory is an `lstat` first, regular files only, and every write goes through a
  rename.** The transcript has been guarded this way since the feature shipped and the sidecars are held to
  it rather than being the exception, including `pi-version`, which predates them and was the one unguarded
  read left. The store is host-only and never mounted, so this is not a container reaching in; what makes
  it worth the lines is that the directory NAME is derived rather than random, so anyone who knows the
  repository and the branch can compute the path and pre-create it. `readFileSync` follows a link, which
  would decide a gate on some other file's contents; `writeFileSync` and `copyFileSync` follow one at the
  destination, which would turn a promotion into a truncating write of any worker-writable file. Writing a
  temp and renaming over the name replaces a link with a regular file and never opens its target. Sidecar
  reads are **size-bounded** for the same reason the transcript is: `PI_SESSION_MAX_BYTES` does not cover
  them, and reading a huge one costs wall clock on the job's own path before any container starts.
- **Write path**, after a `completed` exit **only**: the same `lstat` and size checks on the container's
  output, then an atomic rename under the per-key lock. The two sidecars are written under that lock
  immediately AFTER that rename, and are deliberately not described as part of it: the swap is one rename
  and cannot be widened. **A sidecar write that fails is logged, never fatal**, because it runs after the
  transcript is already promoted and throwing would report `promote-failed` for a promotion that
  demonstrably happened, telling an operator the next run will cold start when it will in fact resume.
  **`locked` means EEXIST and nothing else**: a read-only directory or a full disk also fails to create the
  lock, and reporting those as `locked` sends an operator looking for a stuck lock file that does not
  exist, so they fall through to `promote-failed`. A job that cannot take the lock discards rather
  than clobbers. Everything else the agent left in `/session` is deleted unread with the job dir.
- **Why**: This is the **second** agent-authored channel the host reads back, and `INT-OUTBOX-CONTRACT` is
  the precedent for how such a channel gets described — validated on the way in, never trusted because of
  where it came from.
  **The canonical store is never mounted**, and three properties fall out of that one decision rather than
  needing three mechanisms. `CONST-RETRY-INFRA-ONLY` survives, because a policy or infra exit discards the
  container's writes and attempt 2 starts from exactly what attempt 1 did. `CONST-ISOLATION-CONTAINER-PER-JOB`'s
  *"every one operator- or worker-supplied, none host-wide"* stays true verbatim, because `/session` is
  per-job exactly as `/job` is. And a container can name its own copy and nothing else — the mount is the
  capability, and the hash is not one.
  **`lstat`, regular files only, is security rather than hygiene.** The agent owns `/session`, so a
  symlink it plants resolves on the HOST when the worker reads it back; `stat` + `readFile` would hand the
  next job on that key any worker-readable file. `INT-CONTAINER-JOB-INPUTS` documents this attack in the
  other direction already, and the repo's own habit is the wrong one here: `makeLogReaper` uses `statSync`,
  which follows.
  **The 0-byte staging is what makes pi's own EEXIST race unreachable.** `setSessionFile` takes its
  empty-file branch, writes a header at our exact path and marks the manager flushed, so `_persist` never
  reaches `openSync(path, "wx")` — an exclusive create that would throw the moment two jobs shared a key.
  The host needs no knowledge of pi's file format to get that, and a test pins the header landing, because
  that branch is the one upstream change that would silently re-arm the race.
  **The pi-version gate exists because a transcript outlives the pi that wrote it.** pi's own docs record
  the consequence: an older session's stored tool-call arguments may no longer match the current tool
  schema. The repair hook is an extension-author API and this project does not own pi's built-in schemas,
  so the only available answer is to refuse the resume — which needs the version before the container
  starts, hence an image LABEL read on the preflight's existing `docker image inspect`. An image that
  declares none never resumes: `null` is the safe direction, never "assume it matches".
  **Nothing key-derived crosses the boundary.** The container always sees the constant
  `/session/current.jsonl`, so no repository name, no branch name and no host layout is legible from
  inside a job.
- **Traces to**: `REQ-RESUMABLE-SESSION`, `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-RETRY-INFRA-ONLY`,
  `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-CONTAINER-JOB-INPUTS`, `INT-RUN-HISTORY-FILE-CONTRACT`, `OQ-014`
- **Acceptance**: Given two jobs whose keys differ only in repository or only in branch, their `/session`
  host paths differ and neither is `PI_SESSIONS_DIR` nor a directory under it that the other can name.
  Given a symlink at either edge, it is refused and its target is never read. Given a non-completed exit,
  the canonical file is byte-identical to before the run. Given a second writer holding the lock, the
  loser leaves the canonical transcript untouched. Given an image whose pi version differs from the
  stamped one, the job cold-starts.

## INT-CONFIG-OVERLAY-CONTRACT

**admin extension → worker.**

- **Contract**:
  ```
  settings.json  (PI_SETTINGS_FILE; absolute; unset -> <OS temp>/pi-dispatch/settings.json — same defaulting convention as PI_LOGS_DIR)
  {
    "model":       "<optional, non-empty string>",   // provider-native model id
    "provider":    "<optional, non-empty string>",   // pi provider id
    "maxTurns":    <optional, int >= 1>,             // runner turn budget
    "secretProfiles": <optional { "<name>": "<absolute path to a resolver script>" }>,  // REQ-TRIGGER-SECRETS; deliberately NOT in KNOWN_KEYS, so no model-callable tool can set it
    "dailyCap":    <optional, int >= 1>,             // jobs admitted per day (mandatory window; env default 25)
    "weeklyCap":   <optional, int >= 1>,             // jobs admitted per ISO week; unset -> weekly window disabled
    "monthlyCap":  <optional, int >= 1>,             // jobs admitted per calendar month; unset -> monthly window disabled
    "maxTokens":     <optional, int >= 1>,           // per-job token budget (in-run abort); unset -> per-job token budget disabled
    "dailyTokenCap": <optional, int >= 1>,           // daily token cap (check-AFTER; refuses next job); unset -> daily token counter disabled
    "concurrency": <optional, int 1-10>,             // worker slot count
    "softHoldPct": <optional, int 1-99>              // soft-hold band as a % of each active cap; unset -> band disabled
  }
  ```
  All keys are optional; a missing file is an empty overlay. **Write protocol** (admin extension): validate
  the candidate object, serialise it, write a same-directory `settings.json.tmp`, then `rename` it over
  `settings.json` — an atomic replace, with one EPERM retry on Windows. When the existing file is invalid,
  a write rebuilds it from scratch with the sanitized candidate and surfaces a loud, key-only notice that
  it replaced an invalid file — the write path is the documented repair for a broken overlay, so the
  fail-closed guarantee lives only on the worker's job-start read, which is unchanged. **Read protocol** (worker): read at
  **each job start**; a missing file is an empty overlay and is normal; an unknown key is ignored and
  logged, leaving the file valid; an invalid known key (wrong type or out of bounds) or unparseable JSON
  makes the **whole file** invalid.
- **Why**: The worker resolves the effective job settings at job start — precedence
  `job.data > overlay > env > default` — so this file is the shared, durable truth between the admin
  extension and the worker: a write made while the worker is down is simply read at the next job start.
  `dailyCap`/`weeklyCap`/`monthlyCap`/`softHoldPct` are resolved at the existing pre-container cap check, so
  the overlay changes *which values* the caps and band take, never *when* they are checked
  (`CONST-BUDGET-BEFORE-TOKENS`, `REQ-SPEND-CAPS-MULTI-WINDOW`). An unset `weeklyCap`/`monthlyCap` disables
  that window; an unset `softHoldPct` disables the band. The two token knobs (`REQ-TOKEN-ACCOUNTING-AND-CAPS`)
  resolve the same way but differ in *where* they act: `maxTokens` is forwarded into the container
  (`PI_MAX_TOKENS`, `INT-CONTAINER-RUNTIME-CONTRACT`) and enforced in-run by the runner; `dailyTokenCap` is
  worker-only and, unlike the job-count caps, is enforced **check-AFTER** — a read of prior recorded spend
  before the container plus an `INCRBY` of the job's tokens after it — because token cost is knowable only
  post-run. This is the one overlay knob whose enforcement is not at the same pre-container check point as
  the rest; `CONST-BUDGET-BEFORE-TOKENS` (job count, check-before) is unchanged. See
  `DES-RUNTIME-SETTINGS-FILE-OVERLAY` for why a file, why atomic, and why a present-but-invalid file fails closed.
- **Traces to**: `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, `DES-ADMIN-VIA-PI-EXTENSION`,
  `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`, `REQ-SPEND-CAPS-MULTI-WINDOW`, `REQ-TOKEN-ACCOUNTING-AND-CAPS`
- **Acceptance**: Given a present-but-invalid file, when a job starts, then the processor returns a policy
  refusal `settings-overlay-invalid` before `reserveBudget` — no budget slot consumed, no container
  started, not retried; given a job whose data omits `model`/`provider`/`maxTurns`, when it starts, then
  the value falls to the overlay, then env, then default — not a value frozen at enqueue; given `dailyCap`
  lowered below today's reserved count, when the next job starts, then it is refused over-budget before any
  container; given a concurrent write, when the worker reads, then it never observes a partial file (atomic
  rename); given an unknown key, when read, then it is ignored and logged, and the file remains valid.

---

## INT-PAUSE-WINDOWS-FILE-CONTRACT

- **Producer/Consumer**: The admin extension (operator dialogs + confirm-gated tools) writes; the worker
  reads and enforces (`REQ-SCOPED-PAUSE-WINDOWS`, `DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED`). The receiver does
  not read it.
- **Location**: `PI_PAUSE_WINDOWS_FILE` (unset = feature off; the worker loads `[]`).
- **Shape**: `{ "windows": [ { scope, from, to, tz?, days?, dateFrom?, dateTo? } ] }`.
  - `scope` (required): a github `"owner/name"`, a local folder path, or `"*"` (all). Matched against a job's
    `repo`/`folder` by `kind`, exact.
  - `from` / `to` (required): `"HH:MM"` 24h. `from > to` is an overnight window. `from == to` is **rejected**
    (a 24h pause is not expressible).

    **A one-shot "not before this instant" is not expressible here either, and now lives elsewhere.** Every
    answer this file gives is derived from a daily `to` time, so the shape is a RECURRING band by
    construction; `dateFrom`/`dateTo` bound which days an occurrence may start on, not the band itself.
    `run.waitFor`'s `{ "after": "<ISO instant>" }` (`REQ-WAIT-FOR`) is that missing shape, deliberately as
    a per-trigger field rather than a widening here: a pause is a runtime control an operator edits live
    for a whole scope, and an instant a specific job waits for is reviewed trigger content. The `from ==
    to` refusal above stands unchanged and keeps its reason — an unbounded hold expressed as a pause would
    have no terminal state, while a wait carries its own ceiling and a named terminal reason.
  - `tz` (optional, default `"UTC"`): IANA zone, validated by constructing an `Intl.DateTimeFormat`.
  - `days` (optional, default all): weekday allow-list (`mon`..`sun`) gating the occurrence's **start** day.
  - `dateFrom` / `dateTo` (optional, default unbounded): inclusive `"YYYY-MM-DD"` bound on the start date.
- **Validation**: the SHARED `parsePauseWindows` (worker `./pause-windows`) validates the WHOLE file fail-loud
  (`configError`); the admin writes through it (fail-closed — a rejected file is never written) and the worker
  boot-loads through it. Neither side re-derives the schema, so they cannot drift (mirrors
  `INT-TRIGGERS-FILE-CONTRACT`).
- **Write protocol**: atomic tmp + rename (`writePauseWindows`); the worker's directory watch hot-swaps the
  in-memory windows on change and **keeps the last-good set on a bad edit** (no restart).
- **Enforcement**: at pickup, before `reserveBudget`, a scope-matching active window defers the job with
  `job.moveToDelayed(windowEndMs, token)` + `DelayedError`; it consumes no budget and auto-resumes at the end.
- **Acceptance**: Given a well-formed file with a window covering now for a job's scope, the job is delayed to
  the window end and reserves nothing; given `from == to` or a bad tz/day/date, the write is rejected and the
  file is unchanged; given a mid-run malformed edit, the worker keeps the last-good windows and logs
  `pause_windows_reload_invalid`.

---

## INT-SCOPED-LIMITS-FILE-CONTRACT

- **Producer/Consumer**: The admin extension (operator dialogs + confirm-gated tools) writes; the worker
  reads and enforces. The receiver does not read it. The worker's enforcement is landed; the ADMIN wiring
  (tools, panel, counter display) lands in a later slice of issue #242 — this entry has been the file's
  contract from day one so the sides cannot drift.
- **Location**: `PI_SCOPED_LIMITS_FILE` (unset = no scoped caps and no scoped concurrency; the worker loads
  `[]`). The one-job-per-folder mutex for local jobs is CODE, not configuration: it holds with no file, an
  empty file, or any file, and no row can raise it (`min(configured, 1)` for a local scope — scope strings
  are not reliably typeable folder-vs-repo, so the clamp is silent rather than a parse refusal that would
  misfire on `"a/b"`).
- **Shape**: `{ "version": 1, "limits": [ { scope, day?, week?, month?, concurrent? } ] }`.
  - `version` (required): integer ≥ 1, fail-loud on newer (`scoped-limits file written by a newer
    pi-dispatch (version N; this build understands 1)`). Adopted from `INT-SUBSCRIPTIONS-FILE-CONTRACT`
    because this is a MONEY file: unknown fields are silently dropped per the operator-file policy, so a
    v2 cap field an old worker dropped would be a silently WIDENED spend limit. The protection covers
    STAMPED files only — a hand-edit that plants a future field in a `version: 1` file drops in silence,
    the operator-file policy working as designed.
  - `scope` (required): a forge `"owner/name"` or a local folder path, matched EXACTLY against the job's
    canonical scope — no prefixes, and any scope containing `"*"` is refused at parse (an exact matcher
    would make a glob row silently inert). The bare `"*"` carries its own refusal: the only non-redundant
    reading (a per-scope default) would invert the pause file's `"*"` (one rule matching all scopes); if
    a later version adopts it, an exact row beats `"*"`. Duplicate scopes (after trimming and
    absolute-path resolution) refuse the file. Write local folder scopes as ABSOLUTE paths: the job side
    always resolves, so a relative folder row can never match any local job — and worse, it CAN exactly
    match a same-named forge repo and silently govern that instead; the doctor advisory flags
    unreferenced scopes. Path shape is interpreted with the worker platform's own `path` semantics, so a
    foreign-platform row (a Windows drive path on a POSIX worker) parses, stays verbatim, and is inert on
    that platform — the one place the shared parser is platform-dependent, and the same advisory names it.
  - `day` / `week` / `month` (optional): integer ≥ 1 run caps per UTC day / Monday-start UTC week /
    calendar month, counted per scope beside the global windows. `0` is refused — "never run this scope"
    already has two honest spellings (delete the trigger; a pause window).
  - `concurrent` (optional): integer ≥ 1, the scope's in-flight ceiling, enforced by DEFERRAL through the
    delayed set — never a refusal, a busy scope is transient state. At least one of the four is required.
- **Canonicalization**: a local job's scope is `path.resolve(folder.trim())` and an absolute-path-shaped
  row is stored resolved, so every spelling of one directory (`/srv/site/`, `/srv//site`, `/srv/x/../site`)
  converges on one counter and one mutex slot, and Unicode is NFC-normalized on both sides (macOS's
  filesystem hands back NFD while a dialog types NFC; ASCII is fixed under NFC so no existing key
  changes); symlinks and filesystem case-insensitivity are deliberately not resolved (realpath is an fs
  call on the hot path that can throw; on a case-insensitive volume `/Srv/Site` and `/srv/site` stay two
  scopes — the pause matcher lives with both residuals). Forge scopes pass through with only the NFC
  normalization. A
  resolved local scope is always an absolute path and a repo string never is, so a folder and a repo both
  named `a/b` cannot share counters. The pause matcher keeps the RAW `scopeOf` value — resolving there
  would change which jobs an operator's existing trailing-slash window matches; the folder-vs-repo split
  itself stays defined once, in `scopeOf`.
- **Validation**: the SHARED `parseScopedLimits` (worker `./scoped-limits`) validates the WHOLE file
  fail-loud (`configError`, positional labels); the admin reads AND writes through it and the worker
  boot-loads through it, so the sides cannot drift (mirrors `INT-PAUSE-WINDOWS-FILE-CONTRACT`).
- **Write protocol**: atomic tmp + rename, validated through `parseScopedLimits` before the write. A
  MISSING file starts from the empty v1 shape; an EXISTING file with a missing or newer `version` refuses
  the write (`{ invalid }`) — read and write both refuse, never a silent repair. This deliberately differs
  from `INT-SUBSCRIPTIONS-FILE-CONTRACT`'s repair rule: repairing an analytics file risks nothing, while
  re-stamping an enforcement file's version would launder a newer file's dropped fields into a valid v1 —
  the exact widening the version field exists to prevent. The worker's directory watch hot-swaps on change
  and keeps the last-good set on a bad edit.
- **Enforcement** (issue #242): scoped windows reserve FIRST, between the token-cap read and
  the global `reserveBudget`, under redis keys `budget:s:<16-hex sha256 of the canonical scope>` composed
  by the budget module's own key builders; a scoped refusal returns `reason: "scope-cap"` pre-spend with
  the global ledger untouched and its own counter kept (refused-still-counts, per ledger), and a GLOBAL
  refusal after a scoped reserve releases the scoped slot — neither ledger's REFUSALS may drain the
  other (a mid-reserve redis fault keeps the existing partial-INCR posture, on both ledgers alike). The
  refusal record's `budgetReserved` stays global-only (false on a `scope-cap` even though a scoped slot
  was spent). The worker log names the scope by its 16-hex key, never the raw string (a folder path in the
  log would breach no-PII-in-logs); the forge comment may name the repo it posts on. Concurrency defers at
  the pickup gate with a fixed re-check delay; deferral consumes no attempt, no budget, no record. Since
  issue #230 the delayed set holds a FIFTH population beside cron next-occurrences, retry backoff, quiet
  hours and scope deferrals: jobs held on `run.waitFor`. A POLLED hold is told apart from a scope deferral
  by wake instant, which is why the wait interval floor is deliberately greater than this gate's re-check;
  an `after` hold is not, since it wakes at an instant the operator chose and may legitimately fall inside
  the same few seconds. Nothing records WHY a job sits in the delayed set, which is what makes both
  statements about wake instants rather than about state. No
  per-scope FIFO is promised: a newer job may take a freed scope ahead of an older deferred one, and a
  sustained same-scope arrival rate can starve a deferred job indefinitely — deferral is a gate, not a
  queue. A lowered `concurrent` never preempts in-flight jobs (next-pickup grain); a lowered cap applies
  against counts already accrued. The forge semantic-dedup window is enqueue-time only, so a deferral
  longer than that window admits the next identical delivery — unchanged from pause behavior. Each wake's
  re-delay call is one more transient-redis-failure exposure (the job's `attempts: 2` absorbs a single
  blip). The in-flight counter is process memory with no TTL: a hold leaked past the release seam (none is
  known; the seam is guarded) recovers only by worker restart. `worker_started`'s two new fields (file
  path, row count) and the four `scoped_limits_*` watcher events are LOG-ONLY — telemetry, not contract;
  nothing may parse them. A deployment with no limits file behaves
  byte-identically, key for key and record for record, EXCEPT where the mutex serializes two same-folder
  local jobs — which is the feature, visible in wall-clock and the queue's delayed count, never in keys or
  records.
- **Acceptance**: Given a file with `version: 2`, when either side reads it, then it is refused loudly
  naming both versions, and a write against it is refused without touching the file. Given a row with
  `scope: "*"`, `0` for any bound, a duplicate scope, or no limit field at all, when parsed, then the whole
  file is refused with a positional message. Given rows `/srv/site` and `/srv/site/`, when parsed, then the
  duplicate refusal fires — they are one scope. Given the confirm-gated tools (`dispatch_limit_add` /
  `_edit` / `_delete`, with `dispatch_limits` as the read; the panel's `m` key drives the same writer),
  when an operator approves, then the change lands atomically and the worker's watcher picks it up with
  no restart; when they decline, nothing changes; with no interactive operator, the write tools refuse.
  A partial edit keeps omitted fields; the write REFUSES an existing file with a missing or newer
  version rather than repairing it. The panel and every tool present `concurrent` as CONFIGURATION only
  — per-scope in-flight is worker-process state no reader can see, and no surface invents a number; the
  used day/week/month counts come from the scoped redis keys recomputed through the shared
  `scopeKeyPrefix`, `null`/`?` when the queue is unreachable, never an invented zero. Given no
  `PI_SCOPED_LIMITS_FILE`, then the worker loads
  `[]` and no scoped key is ever created.

---

## INT-WAIT-PROFILES-CONTRACT

- **Status**: LANDED in full, including the running of a check. What remains deferred is stated where it
  belongs rather than here: declaring a profile from the panel (there is no overlay half, and the Why below
  says why there cannot be one), and letting a check return a reason string worth showing on a held row.
- **Producer/Consumer**: operator → worker, through the environment. The receiver carries `run.waitFor`
  into job data and evaluates nothing. The admin extension declares no profile, and READS the `wait:`
  keyspace: the panel's held section and both wait tools take their rows from it.
- **Location**: `PI_WAIT_PROFILES` (unset = the feature is off; every trigger naming a profile refuses
  pre-spend as `wait-profile-unknown`, per delivery, with no token minted and no clone). `name:/absolute/path` pairs, comma separated, each entry split on its FIRST colon so a
  Windows `C:\...` path survives. Set-but-garbled is a BOOT refusal, `parseSecretProfiles`' posture: a
  silently dropped entry is a profile the operator believes is wired, while every trigger naming it
  refuses at delivery with the operator looking at the line that appears to declare it.
- **Why a separate variable from `PI_SECRET_PROFILES`**, which has the identical grammar: the two answer
  different questions (one fetches a value, one says whether to go), they grow different bounds, and one
  merged list would make a resolver reachable as a gate and a gate reachable as a resolver. The duplication
  is the cheaper of the two mistakes.
- **Why there is no `PI_WAIT_RESOLVER_ROOTS` twin.** `PI_SECRET_RESOLVER_ROOTS` exists to bound paths
  arriving from the settings OVERLAY, which is not a reviewed artifact. A wait profile has no overlay half
  to bound, and cannot: the pickup gate runs ABOVE the per-job settings read, so a profile can only ever be
  declared in the environment, beside the forge tokens. A bound with nothing to bound would be theatre.
  Declaring profiles from the panel is deferred, and the roots variable arrives with it if it ever does.
- **Invocation**: the worker spawns the named path with the job's **id-only target** as `argv[1]`
  (`run-history.mjs`'s `targetFor` shape — `owner/repo#12`, or `local:<basename>`), never a title, a body,
  or any payload text. `shell: false`, an argv array, stdin `ignore` so a check that prompts dies at once
  rather than blocking to timeout. It runs on the HOST as the worker, with the worker's environment, before
  the mint, the clone and the budget reservation — the secret resolver's position, and it inherits that
  entry's disclosure: this is not a weaker blast radius than `--env-setup`, it is the same one at a
  different time, and what bounds it is that the operator named the script in a file only they can write.
- **Verdicts**: `INT-RUNNER-EXIT-CODE-PROTOCOL`'s wait-profile table (`0` go, `1` cannot tell → held and
  counted, `2` never → terminal, `3` not yet → held, anything else → `1`). **stdout and stderr are BYTE
  COUNTERS, never strings**: a check's output can echo the ticket, the query or a vendor's error text, and
  a count still tells an operator to go run it by hand. Whether a check may return a reason string worth
  showing on a held row is deferred, because that string is a third party's text arriving through an
  operator's script and would need its own cap, its own escaping and a rule against ever posting it.
- **Bounds, all seven, every overflow LOGGED rather than silent**: `PI_WAIT_CHECK_TIMEOUT_MS` per check
  (SIGTERM, then SIGKILL after a grace); `PI_WAIT_INTERVAL_MS` as the base cadence, **clamped up** to a
  30s floor rather than refused (the poller's "a typo'd `1` must not turn the harness into a hammer" —
  note the clamp covers only a positive integer below the floor, since `0` and a non-integer still refuse
  at boot), backing off with elapsed time toward a 15-minute ceiling — or toward the configured base if the
  operator set one LARGER, since clamping an explicit hourly cadence down to fifteen minutes would be a 4x
  cost overrun in the direction the operator was trying to avoid, from a knob documented as clamped-upward;
  `PI_WAIT_CHECK_SLOTS` concurrent checks per worker process, held to `PI_CONCURRENCY - 1` so a check does
  not take the last free slot from a paid job -- **except at a concurrency of one, where the floor is one
  and a check does take the only slot**, because a ceiling of zero would mean no wait could ever be
  answered on that deployment. Stated rather than implied: it is the configuration where this bound
  protects nothing. **The lease is released on EVERY exit from the polled arm, and the v1.6.1 correction
  is that it was not**: the supersede claim sits between the acquire and the check loop, and both of its
  exits leave the gate (one returns `wait-superseded`, the other re-defers and throws), so a claim that
  refused or could not be verified walked out still holding the slot. At the shipped default of one that
  wedged every wait check on the worker until it restarted, and the symptom pointed at the wrong thing:
  later held jobs kept throttling and eventually recorded `wait-expired` with `max-wait-unchecked`, which
  blames the deployment's capacity for a slot the gate leaked; `PI_WAIT_MAX_MS` total hold for a profile;
  `PI_WAIT_MAX_CHECKS` per job; and `PI_WAIT_MAX_FAULTS` consecutive cannot-tell answers. **Whichever of
  the two hold bounds is reached first ends the job**, and which one that is depends on the cadence: a
  deferral is clamped to what remains of `PI_WAIT_MAX_MS`, so a cadence longer than the remaining budget
  cannot overshoot it, but a job can still exhaust its check count well before its clock.

  **The lease's own overflow is the one an operator cannot otherwise see.** Every other bound here ends
  a job and says so in a record. A lease denial ends nothing: the job simply re-asks later, and a
  deployment whose checking demand exceeds its capacity looks exactly like one whose conditions are slow.
  So consecutive denials are counted per job and a run of them logs `wait_capacity_exceeded` ONCE, naming
  the knobs that move it. Once rather than per wake, because an alarm that repeats every re-check is the
  always-on signal this project rejects everywhere else.

  **`PI_WAIT_AFTER_MAX_MS` is the seventh and is deliberately NOT `PI_WAIT_MAX_MS`.** An `after` condition
  polls nothing: it is one exact `moveToDelayed` to an instant, self-terminating and costing nothing while
  it waits, so bounding it by the polling budget would refuse "hold this until the maintenance window next
  month" for a reason about subprocesses it never runs. It gets its own far larger ceiling and its own
  refusal token, and an instant beyond it is refused at FIRST pickup rather than held uselessly toward it.
- **The operator surface** (issue #230's panel slice): a HELD section in the `/dispatch` panel and two
  tools, `dispatch_waits` (read) and `dispatch_wait_cancel` (confirm-gated write). All three read the
  worker's own `wait:job:*` hashes rather than enumerating the delayed set, and that is a PII decision
  before it is a convenience: a delayed forge job's `.data` holds the issue title, body and username, so
  hydrating one to build a row would pull into the panel exactly what the snapshot refuses to carry. It
  also removes a classifier that could only ever be a guess, since the delayed set mixes five populations
  and records which for none of them. The section is CONDITIONAL and SELF-BOUNDING: absent when nothing is
  held, so a deployment that never waits renders byte-identically to one before this existed; capped, with
  the remainder counted from the whole index rather than from whatever the reader happened to see; and
  foldable under the frame budget while naming no keybinding, because a held row has nothing to drill into
  and a fold that claimed a key it did not have would be worse than one that says only how many it hid. `dispatch_wait_cancel` refuses any job that is not held — a hash with a hold CLOCK, since the worker's
  own counters create that hash before anything is held, so non-emptiness is a different question — and
  refuses one whose queue state is no longer waiting, because `release` is fail-open by design and a stale
  hash can outlive a job that already woke and ran. Its blast radius therefore cannot reach a cron
  occurrence, a retry backoff, or a completed run — writes no run
  record (the job never ran), and cannot be undone, which is why it is confirm-gated like every other write.
- **The 30s floor is load-bearing twice**, and lowering it would break the second silently: it is also what
  distinguishes a wait deferral from a scope deferral by wake instant, since `SCOPE_BUSY_RECHECK_MS` is 5s
  and nothing else records WHY a job sits in the delayed set.
- **The load-time half** (`pi-dispatch doctor`), which `INT-TRIGGERS-FILE-CONTRACT`'s `run.waitFor` bullet
  promised and this contract now states. Four checks, and what separates a FAILURE from a warning here is
  whether something actually refuses: a hard failure means a worker that will not start or a delivery that
  will not run, never a preference.
  - A `PI_WAIT_PROFILES` that does not parse. REPORTED rather than thrown, since an operator running
    doctor is very likely running it because the worker refused to boot on that exact line and a stack
    trace is the least useful answer available. **Asked unconditionally**, and that is the one check here
    which is: `loadConfig` parses this variable on every boot whether or not any trigger holds anything,
    so a garbled value is a worker that will not START, and gating it behind a waiting trigger would hide
    it from precisely the operator it exists for. The ordinary sequence reaches that state — declare the
    variable, restart, then write the trigger — with doctor run in the middle.
  - A profile a trigger names that `PI_WAIT_PROFILES` does not declare. `secretProfiles`' check exactly,
    and for its reason: the file is valid and the deployment is not.
  - A declared path that does not resolve to an executable regular file, probed the same way the checker
    probes it at spawn time (symlinks followed, so a release-directory layout reads alike in both), because
    a path that cannot run is a condition that can never be answered. It FAILS for a profile a trigger
    names and only WARNS for one none does: no job looks the second up, so nothing refuses today, and
    failing the whole command on a retired `.env` entry is the always-on advisory this command avoids.
  - An `after` further out than `PI_WAIT_AFTER_MAX_MS`, which refuses every delivery at first pickup as
    `wait-after-beyond-max`. Doctor holds both the instant and the ceiling, so this is knowable before
    anything is enqueued — the same class of finding as an undeclared profile, and the reason
    `readTriggerFacts` carries `waitAfters` beside `waiting` and `waitProfiles`.

  Everything except the parse is asked **only when a trigger holds something**: a deployment that waits on
  nothing hears nothing about a feature it does not use, which is this command's rule everywhere else. The
  version floor is the deliberate exception to the failure rule and is disclosed once, as `ok`: doctor runs
  on the WORKER host and cannot see the receiver's installed version, so an unconditional warning would be
  the always-on amber the panel's own design rejects — and the skew is already enforced where it can be, by
  the worker's own `wait-skew` refusal, which doctor's line names rather than duplicates. What doctor does
  NOT check is who may write a check script: `PI_SECRET_PROFILES`' resolver gets a group/world-writable
  warning and a wait profile does not, which is a gap rather than a decision, recorded here so the docs do
  not claim otherwise.
- **Acceptance**: Given `PI_WAIT_PROFILES` unset and a trigger naming a profile, the job refuses pre-spend
  as `wait-profile-unknown` with no token minted, no clone and no budget slot. Given a garbled entry, the
  worker refuses to boot naming the variable. Given a check that exits `3`, the job is deferred, writes no
  run record, consumes no attempt and spends nothing, and runs exactly once when the check later exits
  `0` -- including when a SIBLING delivery was held on the same target and cleared alongside it, which
  the lease alone cannot cover because delayed jobs outlive leases across a worker outage.
  Given a check that exits `2`, the job refuses `wait-refused` and never retries. Given a check that always
  exits `1`, the job terminates as `wait-unanswerable` after `PI_WAIT_MAX_FAULTS` consecutive faults,
  naming the profile rather than the condition. Given a check that hangs, it is killed at
  `PI_WAIT_CHECK_TIMEOUT_MS` and the job is held, not failed. Given a deployment that declares no profile,
  every byte of every job is what it was before this contract existed.

---

## INT-SUBSCRIPTIONS-FILE-CONTRACT

- **Producer/Consumer**: operator → admin extension; the worker exports the validator and reads nothing.
  Subscription-backed providers ship all-zero rate tables (pi-ai's `kimi-coding`, `zai-coding-cn`), so their
  runs record cost 0 and read as free when they are prepaid — and the env boundary refuses
  OAuth/subscription logins by design (`env-allowlist.mjs`), so an operator-side declaration is the only
  place the real price can come from (`DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY`).
- **Location**: `PI_SUBSCRIPTIONS_FILE` (the admin defaults to `./subscriptions.json` in its working
  directory, matching the `pi-dispatch init` scaffold — issue #80; unset/absent =
  `{ missing }`, a normal deployment). The committed `subscriptions.example.json` is the template;
  `pi-dispatch init` scaffolds an empty `{ "version": 1, "subscriptions": [] }`.
- **Shape**: `{ "version": 1, "subscriptions": [ { id, vendor, provider, models?, price,
  sharedWithOtherProducts?, hypothetical?, counterfactualModel?, windows? } ] }`.
  - `version` (required): integer ≥ 1. The one field that cannot be retrofitted — see Validation.
  - `id` (required): non-empty string, unique within the file.
  - `vendor` (required): non-empty string — who sells the plan.
  - `provider` (required): non-empty string — the pi-ai provider id the plan covers.
  - `models` (optional, default `["*"]`): non-empty array of model-id globs, charset
    `[A-Za-z0-9*._:/-]`, max 64 chars each.
  - `price` (required): `{ amount: number > 0, currency: 3-letter uppercase, per: "month" }`.
  - `sharedWithOtherProducts` (optional, default `false`): the plan also powers products outside this
    deployment, so its full price is not attributable to these runs.
  - `hypothetical` (optional, default `false`): a plan being CONSIDERED, not owned — priced in analytics as
    a what-if, never as spend.
  - `counterfactualModel` (optional, default none): `{ provider, id }` naming a PRICED pi-ai model to
    re-price covered runs at API rates — what the same runs would have cost pay-as-you-go.
  - `windows` (optional, default `[]`): `[ { per, rolling?, unit?, limit?, scope? } ]` — the plan's usage
    windows. `per` ∈ `5h|7d|30d|month`; `rolling` (optional, default `false`); `unit` ∈
    `tokens|requests|prompts|credits` **or `null`** and `limit` a number > 0, a `[min, max]` range
    (both > 0, min < max), **or `null`** — `null` means the vendor did not disclose it, a FIRST-CLASS
    value, never a default someone invented; `scope` (optional, default all of `models`): non-empty array
    of model globs the window covers.
- **Validation**: the SHARED `parseSubscriptions` (worker `./subscriptions`) validates the WHOLE file
  fail-loud (`configError` with positional labels — `subscription at index N`, `window at index M of
  subscription at index N`); the admin reads and writes through it and the worker exports it without
  reading, so the two cannot drift (mirrors `INT-PAUSE-WINDOWS-FILE-CONTRACT`). A `version` HIGHER than
  the build's is refused loudly, naming both versions (`subscriptions file written by a newer pi-dispatch
  (version N; this build understands 1)`) — fail-loud-on-newer is the one rule a later version cannot add
  retroactively. Unknown fields are silently dropped (the normalizer rebuilds explicit objects — the
  operator-file policy, per `INT-TRIGGERS-FILE-CONTRACT`); any invalid KNOWN field fails the whole file.
- **Write protocol**: atomic tmp + rename (`writeSubscriptions`), validated through `parseSubscriptions`
  before the write — a rejected result is never written, and a missing/unparseable existing file starts
  from the empty v1 shape so a validated write REPAIRS it.
- **Enforcement**: **none — this file changes no runtime behavior; it prices what already happened.** No
  job-time read, no routing, no auth, no model selection; declaring a plan must never become a way to
  route to it.
- **Acceptance**: Given a file with `version: 2`, when the admin reads it, then it is refused loudly with
  a message naming version 2 and the understood version 1 — never a silent partial read. Given a window
  with `unit: null` and `limit: null`, when parsed, then it is valid and renders as unknown — never an
  invented burn-down number. Given any job at any point of its lifecycle, then the worker never opens the
  file — the only reader is the admin extension. Given a duplicate `id` or an out-of-charset glob, when
  written through `writeSubscriptions`, then the write is rejected and the file is unchanged.

## INT-DEPLOYMENT-POINTER-CONTRACT

**setup wizard → admin extension.** The one file that lets `/dispatch` find a deployment built
somewhere else. The worker and the receiver **never read it** — their truth is their own env (the
deploy dir's `.env`, loaded by the service units/wrappers); the pointer only aims the *admin* at the
same files. On drift the failure mode is the panel editing files the services do not read, and the
recorded repair is re-running `/dispatch setup` (or editing the pointer by hand).

- **Location**: `PI_DISPATCH_DEPLOYMENT_FILE`, defaulting to
  `<PI_CODING_AGENT_DIR or ~/.pi/agent>/pi-dispatch-deployment.json` — pi's own agent dir, the
  repo's one established home-dir pattern; a bespoke `~/.pi-dispatch/` tree is exactly the layout
  invention this spec warns against elsewhere. Absent = `{ absent }`, the normal pre-wizard state.
- **Shape**: `{ "version": 1, "deploymentDir": "<abs>", "env": { … } }`. `version` (required):
  integer ≥ 1 — the one field that cannot be retrofitted. `env` is an **allowlisted map**:
  `VALKEY_URL`, `PI_LOGS_DIR`, `PI_SETTINGS_FILE`, `PI_TRIGGERS_FILE`, `PI_PAUSE_WINDOWS_FILE`,
  `PI_SUBSCRIPTIONS_FILE`; every path value must be **absolute** (a relative value would resolve
  against whichever session happens to read it, i.e. silently wrong — dropped).
- **What it may never carry, enforced by the read-side allowlist**: credentials of any kind, and
  capability grants — `PI_DISPATCH_RUN_ROOTS` in this file has **no effect**, because a pointer that
  could widen the AI-run allowlist would be a second, unreviewed door to a capability the panel
  deliberately gates. The pointer resolves paths, full stop.
- **Validation**: unknown top-level fields and unknown/disallowed env keys are silently dropped
  (the operator-file policy); an unparseable file, a non-object, a missing/invalid `version`, or
  `version` **higher** than the build's ⇒ the whole file is **ignored** and a one-line notice is
  surfaced on the next `/dispatch` (naming both versions in the newer-file case). This is
  deliberately weaker than `INT-SUBSCRIPTIONS-FILE-CONTRACT`'s loud refusal, and the reconciliation
  is recorded here: the admin's read-model doctrine is *never throw, always degrade* — a broken
  pointer must leave `/dispatch` exactly as functional as before the pointer existed (env → cwd
  defaults), so fail-loud-on-newer becomes a **surfaced notice, never a throw**.
- **Application**: layered into the process env once at extension load — **the operator's own env
  always wins**, key by key; a later in-process re-apply (after the wizard rewrites the file) may
  update only keys the pointer itself set, never one the operator exported. `resolvePaths` itself
  stays env-only and untouched.
- **Write protocol**: the wizard writes it behind a confirm showing the JSON verbatim; validated
  through the same normalizer (a rejected pointer is never written), atomic tmp + rename;
  hand-editable thereafter.
- **Enforcement**: none at job time — no service reads it, no job input derives from it.
- **Acceptance**: Given a pointer naming `PI_TRIGGERS_FILE` while the operator's env also sets it,
  the env value is used. Given `version: 2`, `/dispatch` behaves as if no pointer existed and
  surfaces one notice naming versions 2 and 1. Given `PI_DISPATCH_RUN_ROOTS` or a provider key in
  `env`, the key is dropped and `dispatch_run`'s allowlist is unchanged. Given a relative
  `PI_LOGS_DIR` value, the key is dropped. Given a deleted pointer, the next pi session resolves
  exactly as today.

## INT-PRICING-EXPORT-CONTRACT

**worker → admin extension.**

- **Contract**: The worker exports `./pricing` (`worker/src/pricing.mjs`), the admin's ONLY road to
  pi-ai's rate tables:
  ```
  listPricedModels()            -> [{ provider, id, cost }]        // every builtin model; cost is pi-ai's table, read-only
  getPricedModel(provider, id)  -> Model | null                    // own-key catalog lookup; never throws on garbage
  isZeroRated(model)            -> bool                            // all four base rates strictly 0 (subscription providers)
  piAiVersion()                 -> "major.minor.patch" | null      // the RESOLVED pi-ai package's version, read from disk
  reprice(quad, {provider,id})  -> { usd, ratesVersion } | null    // quad = {input, output, cacheRead, cacheWrite, cacheWrite1h}
  ```
  `reprice` builds a **fresh `Usage` with a zeroed cost skeleton on every call** — pi-ai's `calculateCost`
  mutates its argument in place and TypeErrors without the skeleton — and inherits pi-ai's own tier
  selection (threshold key = `input + cacheRead + cacheWrite`, request-wide) and 1h cache-write premium.
  Its one judgment call: `cacheWrite1h` is forwarded **only to `anthropic` targets** (clamped to
  `cacheWrite`) and folded into short writes for everyone else — the premium is an Anthropic billing rule,
  and applying a source profile's 1h split to a target that never bills it would invent cost.
- **Why**: pi-dispatch holds no pricing table (`the issue's own constraint`): stream-time cost on the run
  record is the metered truth, and this façade prices **counterfactuals only** — what-if re-pricing and
  the subscriptions' API-rate comparison line. The admin must not grow its own pi-ai dependency: that
  would be a fourth exact pin and a **second drift axis** (admin's tables silently disagreeing with the
  runner's), where importing the worker's export is the same anti-drift idiom `budget`'s `dayKey` and
  `subscriptions`' parser already use. Enumeration goes through `@earendil-works/pi-ai/providers/all`
  (declared side-effect-free) — **never `./compat`**, whose module scope registers api providers.
  The enforcement is a **pinned-artifact guard** (`worker/test/pricing.test.mjs`): it asserts
  `calculateCost`'s mutation contract, the tier threshold key, concrete opus/codex rates, the codex 272k
  tier boundary, the all-zero kimi/zai tables, and the exact resolved version — so a pi-ai pin bump that
  reshapes pricing **fails the build, not the screen**.
- **Traces to**: `DES-COST-FOLD-BY-SCAN`, `DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY`,
  `REQ-TOKEN-ACCOUNTING-AND-CAPS`, `REQ-UPSTREAM-CONTRACT-TESTS`
- **Acceptance**: Given a recorded quad and a priced target model, `reprice` returns the same total
  pi-ai's `calculateCost` computes for that profile, without mutating the caller's quad; given an unknown
  target, it returns `null`, never a guess; given a non-anthropic target and a quad with a 1h split, the
  whole write volume prices at the target's short-write rate; given a pi-ai pin bump that changes any
  pinned rate, table shape, or the mutation contract, the guard test fails the build.

---

## Revision History

| Date | Change |
|---|---|
| 2026-08-30 | v1.6.1, two corrections found by an adversarial pass over the #57 plan rather than by a failure. Both are places where a contract this file states was true of the code one level up and false one level down. **`INT-WAIT-PROFILES-CONTRACT` CORRECTED**: the check lease is released on every exit from the polled arm. It was acquired before the supersede claim and released only around the check loop, so both of the claim's exits -- the `wait-superseded` return and the unverified-holder re-defer -- left holding it. At the shipped default of one slot that wedged every wait check on the worker until restart, and it pointed at the wrong culprit: later held jobs throttled and recorded `wait-expired`/`max-wait-unchecked`, blaming deployment capacity for a leak. Reproduced by driving the real `makeProcessor`, and pinned by two tests whose mutation is the pre-fix block structure. **`INT-RUN-HISTORY-FILE-CONTRACT` CORRECTED, twice, and the pair is one finding**: this file has always said the record is PII-free by construction and that `session.reason` is a CLOSED enum, and neither was enforced where the container's copy is admitted. `parseExitTokens` returned the container's object VERBATIM whenever `total` was numeric, so an invented key -- a path, a branch name, a string read out of the workspace -- reached the durable record; `parseExitSession` accepted any string as `reason`. Both now rebuild: `tokens` from a closed twelve-key list in the runner's own emission order, so a conformant object round-trips byte-identically and an omitted key stays omitted rather than becoming a measured zero; `reason` against the enum this file publishes. The asymmetry that made this findable is that `usage` was already given exactly this treatment (`parseExitUsage`'s rebuild, with the reason written on it) and its two siblings were not -- an oversight, not a decision. **`INT-RUNNER-EXIT-CODE-PROTOCOL` UNCHANGED, checked**: all three fields stay read-only telemetry feeding no classification, and no exit code moves. **`INT-CONTAINER-RUNTIME-CONTRACT` UNCHANGED, checked**: no mount, flag or env var moves, and a conformant image's exit line is accepted exactly as before. **Code evidence**: worker/src/index.mjs -> makeProcessor (the polled arm's try/finally); worker/src/run-history.mjs -> rebuildTokens, SESSION_REASONS, parseExitTokens, parseExitSession. |
| 2026-08-30 | Issue #230, the doctor and docs slice. **`INT-WAIT-PROFILES-CONTRACT` AMENDED**: it now carries the LOAD-TIME half that `INT-TRIGGERS-FILE-CONTRACT`'s `run.waitFor` bullet has pointed at since the grammar landed, four checks, with the FAILURE-versus-warning line drawn at whether something actually refuses -- a worker that will not start or a delivery that will not run, never a preference. An undeclared profile a trigger names (`secretProfiles`' check exactly, the file being valid while the deployment is not); a declared path that does not resolve to an executable regular file, probed the way the checker probes it at spawn, symlinks included, so doctor and the gate cannot disagree about what will run; a `PI_WAIT_PROFILES` that does not parse, REPORTED rather than thrown since the operator running doctor is very likely running it because the worker refused to boot on that exact line; and an `after` beyond `PI_WAIT_AFTER_MAX_MS`, which refuses every delivery at first pickup and which doctor can see before anything is enqueued because it holds both the instant and the ceiling. Two of those four were settled by TESTING the block rather than by writing it, and both inverted a decision the first draft had made. The parse check is now asked UNCONDITIONALLY: `loadConfig` parses `PI_WAIT_PROFILES` on every boot whether or not a trigger holds anything, so a garbled value is a worker that will not START, and the `waiting > 0` gate hid it from exactly the operator the check exists for -- reached by the ordinary sequence of declaring the variable, restarting, and only then writing the trigger. And a declared profile NO trigger names now only warns, because nothing looks it up and failing the whole command on a retired `.env` entry is the same always-on advisory the gate exists to prevent. Everything else stays behind `waiting > 0`, which is why `readTriggerFacts` grew `waiting`, `waitProfiles` and `waitAfters`: a deployment that holds no jobs must hear nothing about a feature it does not use. One gap is recorded rather than closed: a resolver gets a group/world-writable warning and a wait profile does not, so the docs say plainly that doctor checks what a check IS and not who may edit it. The VERSION FLOOR is the deliberate exception and is disclosed once as `ok: true` -- doctor runs on the worker host and cannot see the receiver's installed version, so an unconditional warning would be the always-on amber the panel's own design rejects, and the skew is already enforced where it can be by the worker's own `wait-skew` refusal, which the line names rather than duplicates. **`INT-TRIGGERS-FILE-CONTRACT` UNCHANGED, checked**: no field, no load refusal and no pre-spend refusal moved; this slice builds the half it already promised. **`INT-RUN-HISTORY-FILE-CONTRACT` UNCHANGED, checked**: doctor writes no record and the reason enum gains nothing. **`INT-CONFIG-OVERLAY-CONTRACT` UNCHANGED, checked**: the eight `PI_WAIT_*` keys still join no `KNOWN_KEYS`, and doctor reads them from the environment for the same reason the gate does. Operator docs land with it: NEW `docs/wait-for.md` on `docs/scoped-limits.md`'s section shape, organised by CHECK SHAPE with the vendors as instances rather than one section per vendor, carrying the version floor in `docs/secrets.md`'s own words and leading its traps with the receiver skew, which is the one failure whose symptom is a run that looks entirely correct. `docs/scoped-limits.md`'s "deferrals are visible only as the delayed count" caveat is corrected rather than deleted -- a SCOPE deferral still is, a wait no longer is, and the reason only one of them earned a section is stated so the asymmetry does not read as an oversight. One defect found while building it is fixed here rather than filed, and it was not in the new code alone: both `parseWaitProfilesSafe` and the `parseSecretProfilesSafe` it was copied from returned the profile table with an `error` key beside the profiles, and `error` passes the profile charset -- so `PI_SECRET_PROFILES=error:/opt/pi/r.sh` declared one profile whose PATH then read as a parse failure, and doctor reported the variable as unparseable, quoted the path as the message, and skipped every check below it on a deployment that was entirely correct. Both return an envelope now and both are pinned, since the second was the first's copy and a fix to one alone would leave the older half broken. No contract term moved: `INT-WAIT-PROFILES-CONTRACT` and `INT-TRIGGERS-FILE-CONTRACT` both already say what an undeclared profile does, and this is doctor failing to ask the question rather than the answer changing. The version floor those docs and doctor both state (worker 1.6.0, admin 1.6.0, receiver 1.4.0) names versions this tree does not yet carry, and that ORDERING is a dependency rather than an oversight: the release slice bumps all four package versions plus the wizard's `RUNTIME_VERSION` and `RECEIVER_VERSION`, and it must land before anything here is published, or doctor tells an operator to run a worker newer than the worker printing the line. **Code evidence**: worker/src/doctor.mjs -> readTriggerFacts, collectChecks (the wait block), statPath, parseWaitProfilesSafe, parseSecretProfilesSafe; worker/src/config.mjs -> loadConfig (the unconditional parse this mirrors). |
| 2026-08-30 | Issue #230, the panel slice. **`INT-WAIT-PROFILES-CONTRACT` AMENDED**: the operator surface is now specified -- a conditional, self-bounding HELD section plus `dispatch_waits` and `dispatch_wait_cancel`, all reading the worker's own `wait:job:*` hashes rather than the delayed set. That is a PII decision before a convenience one: a delayed forge job's `.data` carries the issue title, body and username, and the panel's only precedent for touching a queue job reads ONE id off the active one and says why. It also removes a classifier that could only have been a guess, since the delayed set mixes five populations and records which for none. `dispatch_wait_cancel` is the only lever that reaches a held job -- a hold spends nothing so no cap refuses it, and `job.data.trigger` is a frozen snapshot so deleting the trigger does not reach it -- and it refuses anything not actually held, checked against the hash rather than the queue, so it cannot reach a cron occurrence or a retry backoff. **`INT-RUN-HISTORY-FILE-CONTRACT` UNCHANGED, checked**: cancelling writes NO record, because the record contract covers terminal states of RUNS and a cancelled hold never ran; the reason enum gains nothing in this slice. **The no-index decision from the enforcement slice is REVERSED here, and the reversal is the finding**: that slice removed `wait:held` because a SET cannot expire its members, so every hold ending by any route except the clean one would leave one behind. True, and it traded a bounded leak for an unbounded cost -- enumerating `wait:job:*` means a SCAN of the whole keyspace, which the panel does every second, and which walks ALL of it precisely when nothing is held because the early exit never fires. The index is back with the leak handled where it belongs: the READER prunes a member whose hash is gone, staleness is bounded by the next read, the hashes stay the source of truth, and listing held jobs costs O(held) instead of O(keyspace). **Code evidence**: admin/src/read-model.mjs -> readHeldJobs, cancelHeldJob; admin/src/dashboard.ts -> heldSection; admin/src/render.mjs -> renderHeldJobs; worker/src/wait-state.mjs -> makeWaitState (hold, release). |
| 2026-08-30 | Issue #230, the polled tier. **`INT-WAIT-PROFILES-CONTRACT` AMENDED**: Status is now LANDED IN FULL, and its `Location` parenthetical says what it always meant to -- an undeclared profile refuses per delivery as `wait-profile-unknown` with no token minted and no clone. **`INT-RUNNER-EXIT-CODE-PROTOCOL` UNCHANGED, checked**: its wait-profile table landed with the grammar and this slice is the code catching up to it; `0`/`1`/`2`/`3` mean exactly what the table said, `1` and every unrecognised code hold AND count as a fault, and the fault count is what turns OQ-030's unenforceable convention into something bounded. **`INT-RUN-HISTORY-FILE-CONTRACT` AMENDED**: the `reason` enum gains the three terminal tokens the polled tier can reach -- `wait-refused` (the check says never, exit 2, terminal by the protocol's own words), `wait-unanswerable` (`PI_WAIT_MAX_FAULTS` consecutive answers that could not tell, which names the CHECK rather than the condition because a broken script is the likelier cause) and `wait-expired` (the maximum hold or the per-job check count, whichever came first). Three rather than one because each names a different thing to go and look at. The maximum hold is tested AFTER a check and never before it, so a condition that cleared on the deciding wake RUNS -- without that ordering the backoff's own quantisation would make "cleared at t+1s, declared never-cleared at t+900s" structural, which is a lie in a durable record and in a public forge comment. **Code evidence**: worker/src/wait-check.mjs -> makeWaitChecker; worker/src/index.mjs -> makeProcessor (the tier-2 arm); worker/src/wait-state.mjs -> makeWaitState (counters, noteCheck). |
| 2026-08-30 | Issue #230, enforcement slice for the free tier. **`INT-RUN-HISTORY-FILE-CONTRACT` AMENDED**: the `reason` enum gains four pre-spend policy tokens, all `budgetReserved: false` — `wait-skew` (the authored trigger declares conditions the job arrived without), `wait-profile-unknown` (a condition this deployment cannot answer), `wait-superseded` (another delivery for this target is already held) and `wait-after-beyond-max` (an instant further out than the ceiling, refused at first pickup). Four rather than one because each names a DIFFERENT operator action: upgrade a service, declare a profile, nothing, or edit the instant. `wait-after-beyond-max` is deliberately not `wait-expired`: nothing expired, and a reason that said so would be a lie in the durable record. No new outcome and no new record FIELD — `waitedMs` was considered and rejected, since a nullable key breaks every byte-identity `deepEqual` and the hold clock lives in the worker's own keyspace instead. **`INT-WAIT-PROFILES-CONTRACT` AMENDED** (Status): the `after` hold and the pre-spend refusals are landed, so `Location`'s fail-closed parenthetical is now true rather than aspirational; what remains unbuilt is the running of a check. **`INT-PAUSE-WINDOWS-FILE-CONTRACT` AMENDED**: its `from == to` refusal stands unchanged, and now says where the shape it refuses actually lives — a one-shot instant is a per-trigger field, not a widening here, because a pause is a runtime control over a scope while an instant is reviewed trigger content. **`INT-SCOPED-LIMITS-FILE-CONTRACT` AMENDED**, one sentence: the delayed set holds a fifth population, told apart from a scope deferral by wake instant, which is what makes the wait interval floor's relationship to `SCOPE_BUSY_RECHECK_MS` load-bearing rather than incidental. **`INT-RUNNER-EXIT-CODE-PROTOCOL` UNCHANGED, checked**: the wait-profile table landed with the grammar and no participant's codes moved. **`INT-TRIGGERS-FILE-CONTRACT` UNCHANGED, checked**: every load refusal it documents was already landed; this slice adds only pre-spend ones, which it already pointed at. The enum gains a FIFTH token, **`wait-unreadable`**, for the mirror case: a job carrying a condition this worker cannot read, which is the same version skew from the other side. Two tokens rather than one because the remedies are opposites -- upgrade the receiver for `wait-skew`, upgrade the worker for this -- and a durable record carrying one token for both would tell an operator that something is out of step without saying which way to move. **`INT-WAIT-PROFILES-CONTRACT` further corrected after review**: its `Location` parenthetical claimed the unset-variable case refuses per trigger, which reads as though the declared case does not; until the checker lands EVERY profile condition refuses, declared or not, and the bullet now says so. Its `Producer/Consumer` line claimed the admin reads held state, which is a slice away -- the `wait:` keyspace currently has a writer and no reader, and pretending otherwise is the same overclaim the Status bullet exists to prevent. **Code evidence**: worker/src/index.mjs -> makeProcessor; worker/src/wait-state.mjs -> makeWaitState (claim, the three-way supersede answer); worker/src/triggers-file.mjs -> makeCheckWaitSkew. |
| 2026-08-30 | Issue #230, grammar slice (inert: nothing evaluates a wait yet, and the entries say where enforcement lands). **NEW `INT-WAIT-PROFILES-CONTRACT`**: `PI_WAIT_PROFILES`, the id-only-target invocation, byte-counted streams, the six bounds and the acceptance. It records two absences with their reasons, because both look like oversights: there is no `PI_WAIT_RESOLVER_ROOTS` twin (the pickup gate runs above the per-job settings read, so a wait profile has no overlay half to bound, and a bound with nothing to bound would be theatre), and the grammar is duplicated from `PI_SECRET_PROFILES` rather than shared (one merged list would make a resolver reachable as a gate). **`INT-RUNNER-EXIT-CODE-PROTOCOL` AMENDED**, and this is the change a reviewer should read first: it gains a THIRD participant and the first code no other participant speaks, `3` = *not yet*, whose queue behaviour is **Held** — neither a retry nor a refusal, which is a behaviour this protocol did not have. The table is now stated PER PARTICIPANT rather than as one table with footnotes, and the "the same three codes" sentence is scoped to the resolver, which still speaks three. The entry argues past its own extension rule rather than citing it: new vocabulary rides `reason` on the exit log line, and a wait profile has no exit log line and (while held) no run record, so the rule's mechanism is what is missing, not its intent. The widening is bounded by being per-participant and BOTH directions are test-pinned — a container exiting `3` is still `unknown container exit 3` and infra-retries, a resolver exiting `3` is still `unreachable`. **`INT-TRIGGERS-FILE-CONTRACT` AMENDED**: the `run.waitFor` bullet, its load refusals, the three combination refusals (`cron`, `on.once`, `run.replicas`) each with the mechanism that forces it, the pre-spend `wait-profile-unknown` split, and the JOB-level placement, which here is a CORRECTNESS requirement rather than the convention it is for `image`/`skillsDir` because `trigger` is copied verbatim into `/job/event.json`. One inversion is called out as deliberate: an unknown key inside a condition is REFUSED, not dropped, because elsewhere a dropped key is a field that does nothing while here it is a term of a gate that does nothing. **`INT-RUN-HISTORY-FILE-CONTRACT` UNCHANGED, checked**: no wait reason token lands until the enforcement slice, and the record shape gains no field in this issue at all — `waitedMs` was considered and rejected, since a new nullable key breaks every byte-identity `deepEqual` and the panel reads the hold clock from the worker's own keyspace instead. **`INT-CONTAINER-JOB-INPUTS` UNCHANGED, checked**, and the check is the point: both event writers build explicit literals rather than spreading `job.data`, so a JOB-level `waitFor` cannot reach the container and no amendment is owed. **`INT-CONFIG-OVERLAY-CONTRACT` UNCHANGED, checked**: the slice adds eight env keys and not one of them joins `KNOWN_KEYS`, deliberately and for the reason the new contract states at length — the pickup gate reads its config ABOVE the per-job settings read, so an overlay-declared wait profile could not be seen by the gate that would run it, and a key that cannot be honoured must not be offerable. The restructure of the protocol entry moved no container text: its table and every normative paragraph under it (the worker-abort override, the `try`/`catch`-plus-`stopReason` requirement, the failure table, `StopReason`, the command-job reasons and the read-only telemetry fields) stay in one bullet, with the wait profile's table appended after them rather than spliced between. |
| 2026-08-30 | Issue #242, docs and doctor slice. **`INT-SCOPED-LIMITS-FILE-CONTRACT` clauses now fully landed, checked**: the "doctor advisory flags" sentence is implemented — a scaffolded-but-unpointed file warns (the pause trap's twin, with the mutex parenthetical so the check never implies local folders run ungated), a configured file that will not load is a FAILURE naming the boot refusal, and unreferenced scopes are advised by MEMBERSHIP against the triggers' canonicalized folder facts (a path-shape heuristic would be blind to the legal relative `run.folder` rows that are exactly the dead config this catches), with repo scopes advised under the webhook caveat rather than exempted. `pi-dispatch init` scaffolds the empty v1 file; `docs/scoped-limits.md` is the operator reference and `docs/workflows.md` retires the "one trigger per folder" workaround the mutex closed. No contract terms changed — this row records that every promised surface now exists. |
| 2026-08-29 | Issue #242, admin slice. **`INT-SCOPED-LIMITS-FILE-CONTRACT` AMENDED** (acceptance): the confirm-gated tool trio + `dispatch_limits` and the panel's `m` key are landed; approve-applies-live / decline-changes-nothing / headless-refuses acceptance added, with the refuse-never-repair write rule now exercised by the admin writer (read THROUGH the shared parser — deliberately not the pause writer's raw-array scavenge, which would re-stamp a newer file's version) and the config-only concurrency display stated as contract. **`INT-CONFIG-OVERLAY-CONTRACT` UNCHANGED, checked**: `dispatch_set`/KNOWN_KEYS untouched; the limits ride their own file and tools. **`INT-DEPLOYMENT-POINTER-CONTRACT` terms carried**: the pointer env allowlist gains `PI_SCOPED_LIMITS_FILE` (the fourth cwd-default file), or a wizard-pointed deployment's panel would edit a file the worker never reads — the exact drift the pointer exists to prevent. |
| 2026-08-29 | Issue #242, enforcement slice. **`INT-RUN-HISTORY-FILE-CONTRACT` AMENDED**: the `reason` enum gains `scope-cap` — the pre-spend policy refusal for a job over its scope's day/week/month window; a fixed token like every sibling, with the scope named only in the forge comment and, as its 16-hex key, in the worker log (no-PII-in-logs); `budgetReserved` keeps its global-only meaning, false on a scope-cap even though the scoped counter kept its refused reservation. **`INT-SCOPED-LIMITS-FILE-CONTRACT`'s Enforcement section is now landed code, checked against it**: scoped-reserves-first between the token-cap read and the global reserve, the compensating release on a global refusal, both-or-neither refund on `container-never-started`, the 5s re-check deferral above the processor's try, the setup guard, and the release-first finally. **The `REPLICAS_MAX` rationale AMENDED**, one sentence: a repo's `concurrent` limit can bound a replica set below the ceiling too, by deferral — a second bounding axis, not an exception. **`INT-CONFIG-OVERLAY-CONTRACT` UNCHANGED, checked**: scoped limits deliberately do NOT ride the overlay (the gate reads a watched ref above the per-job settings read); the design entry's stale key list was corrected in the same PR. |
| 2026-08-29 | Issue #242, schema slice. **NEW `INT-SCOPED-LIMITS-FILE-CONTRACT`**: `scoped-limits.json` (`PI_SCOPED_LIMITS_FILE`), per-scope day/week/month run caps and per-scope concurrency on the pause-windows scope vocabulary, shared-parser validated (`./scoped-limits`), versioned fail-loud-on-newer with a refuse-never-repair write rule, canonical (resolved) local scopes so one directory's spellings share one counter and one mutex slot. The enforcement and the admin/worker wiring land in this issue's later slices; the contract states their terms up front so the slices implement it rather than re-derive it. **`INT-PAUSE-WINDOWS-FILE-CONTRACT` UNCHANGED, checked**: `scopeOf` stays the single folder-vs-repo split and the pause matcher keeps matching the RAW scope — the new file's canonicalization is its own, recorded in both entries' terms. **`INT-SUBSCRIPTIONS-FILE-CONTRACT` UNCHANGED, checked**: its version rule is adopted by the new contract, its write-repair rule deliberately is not (analytics may repair; enforcement config must refuse), stated in the new entry. |
| 2026-08-29 | Issue #231, surfaces slice, one CORRECTION. **`INT-TRIGGERS-FILE-CONTRACT` AMENDED**: the close-words paragraph claimed a merge that should release work "is a close too" unqualified; that holds on GitHub and Forgejo (both emit `closed` for a merged PR) and is FALSE on GitLab, whose `merge` is its own action no rule takes, so a GitLab close rule fires on an explicit close only. Stated as a per-forge gap rather than glossed; the READMEs, the operator skill and docs/gitlab.md carry the same qualification. No behavior changed, only the claim. |
| 2026-08-29 | Issue #231, worker slice. **`INT-RUN-HISTORY-FILE-CONTRACT` AMENDED**: the `reason` enum gains `once-already-spent` -- the pre-spend policy refusal for a close job whose one-shot a FOREIGN job already spent (the job's own earlier attempt is excused, so BullMQ's attempts:2 survives; the refusal posts the sibling-pattern forge comment). Same admissible class as every policy reason: a fixed token, never payload text. **`INT-TRIGGERS-FILE-CONTRACT` UNCHANGED, checked**: the disarm writes exactly the `on.disarmed` mark that contract already specifies; the writer landed two slices ago and only its callers are new. |
| 2026-08-28 | Issue #231, poller slice. **`INT-WEBHOOK-PAYLOAD-SUBSET` AMENDED** (synthesized row): the `closed` source rides the existing `/issues/events` feed -- a `closed` entry's `actor` is the closer with `{ id, login }` (verified live), PRs appear there discriminated by `issue.pull_request` and a merged PR emits `closed`, the PR arm fetches the PR once for shape parity, delivery ids stay `poll-e<event>`; the closer gate runs in the poller's choke point with the webhook arm's one-derivation predicate, an indeterminate lookup holds the cursor and retries, bounded, then drops that one close loudly (`poll_close_gate_gave_up`) -- nothing redelivers to a poller, so the availability half of fail-closed is a bound, not a wedge. Nothing is synthesized from open-PR-list disappearance (it cannot name the closer). The receiver-slice sentence "close triggers fire over webhooks only" is retired. **`REQ-DEDUP-BY-DELIVERY-GUID` UNCHANGED, checked**: `poll-e` ids were already in the `gh-` dedup space; closes add no id family. |
| 2026-08-28 | Issue #231, receiver slice. **`INT-WEBHOOK-PAYLOAD-SUBSET` AMENDED**: `closed` consumed on `issues` and `pull_request` (merge-closes emit `closed` too, stated); `sender.login` joins the body-field list with exactly one consumer, the closer-permission lookup -- never logged, never enqueued, the job's `trigger.sender` stays `{ id }`; the reviews-source sentence that cited `close` as never-actionable is corrected, and the polling transport's `closed` source is marked as the poller slice's. **`INT-GITLAB-PAYLOAD-SUBSET` AMENDED**: `close` actionable on issues (close route first, label-route fallback when the same delivery adds labels -- a close-and-label call fires label rules today and keeps doing so) and merge requests; NO field added. **`INT-FORGEJO-PAYLOAD-SUBSET` AMENDED**: `closed` leaves the recognised-but-not-actionable set into both action maps; a rule-less close drops `no-matching-close-trigger`; NO field added. **`INT-RUN-HISTORY-FILE-CONTRACT` AMENDED**: the `triggerType` enum gains `"issue"` (a passthrough of `matched.type`; PR closes reuse `"pull_request"`, zero record-shape change for them). **`INT-AZURE-PAYLOAD-SUBSET` UNCHANGED, checked**: azure close triggers are refused at load, so nothing new is consumed. **`INT-CONTAINER-JOB-INPUTS` AMENDED**: `matched` gains `number` (issue shape, harness-computed integer) and conditional `once: true` on close jobs only -- reviewState's absent-stays-absent terms, every non-close job's `matched` byte-identical; the entry's matched clause names both. |
| 2026-08-28 | Issue #231, first slice (schema). **`INT-TRIGGERS-FILE-CONTRACT` AMENDED**: new `on.type: "issue"` (close events; github/forgejo `closed`, gitlab `close`, azure refused at load as *not yet covered*) and the close-only `pull_request` rule (the close word joins the PR vocabulary but never mixes with other actions -- a close gates on the CLOSER, everything else on the author); `on.number` narrows a close rule to one item; `on.once` is the one-shot (strict boolean, `true` requires `number`, refused beside `run.replicas`); `on.disarmed { at, jobId? }` is the worker-written spent mark, and a disarmed entry validates in full, keeps its raw position, and normalizes to the validator-only sentinel `{ on: { type: "disarmed" }, run: {} }` so nothing downstream can match it. `run.flow` on the webhook kinds now must match the skill-name charset -- the file's one narrowing: it converts materialize's post-budget refusal into a free load-time one and keeps `:` out of the semantic dedup key's flow slot. The "merge and close are omitted, nothing left to act on" sentence is REWRITTEN: a job about the closed thing stays refused, a close that releases separately-armed work is the new case. **`INT-CONTAINER-JOB-INPUTS` UNCHANGED, checked**: nothing new crosses into the container in this slice -- close jobs' `data`/`event.json` shape lands with the receiver slice. **`INT-WEBHOOK-PAYLOAD-SUBSET` UNCHANGED in this slice, checked**: no subset field moves until the receiver routes closes. |
| 2026-08-28 | Issue #224. **`INT-RUN-HISTORY-FILE-CONTRACT` AMENDED**: the five exit-line parsers repair a GLUED line (a partial write from whatever shares the container's stdout, landing as `<stray bytes><runner line>` in one line) by re-anchoring on the runner writers' first-key bytes before skipping it, and both runner writers are newline-DELIMITED rather than merely newline-terminated -- the reader edge covers logs an older image already wrote, the writer edge covers everything downstream of a pull. A repaired value stays read-only telemetry. **`INT-RUNNER-EXIT-CODE-PROTOCOL` UNCHANGED, checked**: classification never read this line and still does not -- a repaired line changes what the record reports, never the queue outcome. **`INT-CONTAINER-JOB-INPUTS` UNCHANGED, checked**: nothing new crosses into the container; the leading newline is output discipline, not an input. |
| 2026-08-26 | **`INT-TRIGGERS-FILE-CONTRACT` AMENDED** (issue #225): `run.secrets` and `run.secretsProfile` on all four kinds, with the load-time refusals and the pre-spend ones split by what a pure, fs-free validator can answer. **`INT-CONTAINER-RUNTIME-CONTRACT` AMENDED**: resolved values join the closed map, assigned after `PI_FORWARD_ENV` and before both the egress variables and the minted token, so a trigger outranks the operator's blanket host list and outranks neither the network policy nor the per-job credential. **`INT-RUN-HISTORY-FILE-CONTRACT` AMENDED**: five new `reason` tokens, plus four the code already emitted and this enum had drifted from (`job-image-forge-unsupported`, `job-image-commands-unsupported`, `daily-token-cap`, `soft-hold`). Every new token was checked against the nested `session.reason` enum for the collision rule. **`INT-CONFIG-OVERLAY-CONTRACT` AMENDED**: `secretProfiles`, deliberately absent from `KNOWN_KEYS` so `dispatch_set` cannot reach it. **`INT-RUNNER-EXIT-CODE-PROTOCOL` AMENDED**: a second participant, speaking the same three codes for the same reason. **`INT-OUTBOX-CONTRACT` UNCHANGED, checked**: a chained child inherits neither field, and the explicit-property-reads rule is what makes that true by construction. |
| 2026-08-26 | Issue #186 (resume eligibility bounds). **INT-SESSION-STORE-CONTRACT AMENDED**, four edits. The key directory's file enumeration was CLOSED at three files and grows to five: `resume-chain` and `context`, both written inside the existing promotion lock and the same atomic swap, so neither can ever describe a transcript other than the one beside it. The read-path order gains two arms and, for the first time, says why the order is itself the contract rather than an implementation detail: the first miss is the one that names itself, so the shape check stays AHEAD of the age bound (a damaged transcript must read `unparseable`, not as a lineage that aged out) while the chain and context arms sit BEHIND `pi-version` and ahead of the header read, because they are sidecar reads that ask about the LINEAGE rather than the file and refusing on them need not pull a transcript that may be megabytes. The cost of that placement is recorded rather than left to be discovered: a transcript both chain-exhausted and corrupt reports the chain, and the corruption is deferred by exactly one run, since that cold start's own promotion resets the counter. Two new bullets carry the sidecars' own contracts, including the three decisions each: the chain counter counts the HOST's deliveries, is maintained whether or not a bound is set (a counter that starts when the knob does is a bound that does nothing for its first N runs), and reads absence as zero. It counted the container's `resumed` first, and an adversarial pass refuted that: the agent owns `/session`, so a transcript carrying a valid header with its payload on lines pi's parser DROPS is delivered every run while pi reports zero messages, which reset the counter every run and meant the bound never fired. Measured against the pinned pi. The host's decision to hand the file over is the only half of the exchange nothing in the container can influence, so that is what it counts; the context sidecar stores both numbers rather than a percentage so a refusal can be read against what judged it, stamps the MODEL beside them (a key is `(kind, repo, ref)` and carries none, so two triggers on one issue may name different models and the same token count is most of a small window and almost none of a large one; a foreign reading is ignored, unknown on either side stays usable), is left in place by a RESUMED promotion that measured nothing (a zero would read as "the context emptied", the one thing that cannot have happened) but CLEARED by a cold start (keeping it there made one high reading refuse a key forever, since the gate cold-started on a stale number and the cold start left it behind, and nothing releases it because every promotion refreshes the transcript's mtime), and records the rejected `bytes`-against-`contextWindow` fallback -- no bytes-to-tokens calibration exists here, and `bytes` is the whole branch INCLUDING what compaction folded away, so it over-reads exactly past the threshold the bound exists for and would fire hardest on the sessions that had just become safe. **INT-RUN-HISTORY-FILE-CONTRACT AMENDED**: three nested `session.reason` tokens (`conversation-too-old`, `resume-chain-too-long`, `context-too-full`), the producer table's resolve row, and **the second precedence rule this entry never recorded**. It documented promote-beats-the-rest and was silent on runner-beats-host, and that silence was load-bearing: a reader told which tokens are unreachable concludes the rest are reachable, while in fact `expired` and `pi-version-changed` could reach no record whose container emitted an exit line, which is every ordinary run. The mechanism is spelled out because it is invisible from either half of the code alone (0-byte staging, `PI_SESSION_FILE` emitted whenever a session exists at all, and pi's `setSessionFile` gating its own refusal on `size > 0`), and so is the narrowness of the fix, `resume === false` on the host side and exactly `absent` on the runner's. Every new token was checked against the terminal enum for the collision rule at `:649-652`. Four further clauses came out of an adversarial review of the shipped branch and are recorded because each was a real defect rather than a hardening idea: **every read in a key directory is now an `lstat` first and every write goes through a rename**, since `readFileSync` follows a link (deciding a gate on another file's contents) and `writeFileSync`/`copyFileSync` follow one at the destination (turning a promotion into a truncating write of any worker-writable file), and the directory NAME is derived rather than random so the path is precomputable -- `pi-version` inherited the guard as the one unguarded read that predated the sidecars; **sidecar reads are size-bounded**, because `PI_SESSION_MAX_BYTES` never covered them and a huge one costs wall clock on the job's own path; **a sidecar write that fails is logged, never fatal**, because it runs after the transcript is already promoted and throwing returned `promote-failed` for a promotion that demonstrably happened, which told an operator the next run would cold start when it would in fact resume and froze the counter below its bound forever; and **`locked` means EEXIST and nothing else**, since a read-only directory or a full disk also fail to create the lock and reporting those as a concurrency event sends an operator looking for a stuck file that does not exist. **INT-RUNNER-EXIT-CODE-PROTOCOL AMENDED**: `context` joins `turns`, `tokens` and `usage` as read-only telemetry that feeds no classification, a SIBLING of `tokens` for the reason the ledger is one (`tokens` is a per-run BILLING snapshot with two producers; occupancy is neither billing nor per-run), OMITTED rather than nulled when there is no measurement, and deliberately given no `dev.pi-dispatch.capabilities` entry -- capabilities are an INCLUSION list for what the host DEMANDS of an image, and additive telemetry has nothing `verify-image.sh` could grep that would mean anything. What that costs is on the record too: the bound it feeds is inert on an old image and stays inert forever on one that is never rebuilt. **INT-TRIGGERS-FILE-CONTRACT UNCHANGED, checked**: all three bounds are deployment state rather than trigger content, and a per-trigger relaxation of a safety bound is the shape `run.network` was refused for. **INT-CONTAINER-RUNTIME-CONTRACT UNCHANGED, checked**: no mount, no flag and no env var moved, and the container is handed exactly what it was before. **INT-SDK-SESSION-OPTIONS UNCHANGED, checked**: `getContextUsage()` is read off the session the runner already built, and no option changed. |
| 2026-08-26 | Issue #187 (`run.replicas` on every forge). **INT-TRIGGERS-FILE-CONTRACT AMENDED**: the field's scope goes from github-only to every webhook kind on every forge, in all three schema blocks and the prose; the four refusals become **three**, and the surviving `local` one is recorded as the ONLY kind gate, so its position ahead of the range check is load-bearing (move it and a cron entry carrying `replicas: 2` is ACCEPTED rather than refused with a different message); the jobId and dedup key generalise to the forge table's own prefix and separator, which is what makes a GitLab MR `project!5:flow:r2` rather than a second `#` sequence; and a new **webhook-only** clause states plainly that the poller is GitHub-only, because a scope that said "every forge" and stopped would have claimed a parity the feature does not have. Acceptance now says **every loader** rather than both services — there are three, and the third is the reason this issue is a coordinated release rather than a diff. The `1`-is-refused, `3`-is-the-ceiling and `resume` clauses are byte-unchanged. **INT-RUN-HISTORY-FILE-CONTRACT UNCHANGED, checked**: `replica`/`replicas` were always host-assigned integers with no forge in them, and `target` already composed through `targetSeparator`, so a gitlab MR replica records `grp/proj!7` with no contract change — asserted rather than assumed, because this file's own history records `targetFor` once enumerating github alone while every GitLab run silently wrote `target: null`. **INT-CONTAINER-JOB-INPUTS and INT-WEBHOOK-PAYLOAD-SUBSET UNCHANGED, checked**: `event.json` still carries the delivery's own body plus one decision record, and an execution knob is still not a fact about the delivery, on four forges as on one. **INT-CONTAINER-RUNTIME-CONTRACT UNCHANGED, checked**: the `replicas` capability label is read from `job.replica` alone and `verify-image.sh` proves it by grepping the baked guardrails for *"the branch your prompt names"*, a phrase with no forge in it, so every already-conformant image serves non-GitHub replicas with no rebuild. **INT-OUTBOX-CONTRACT UNCHANGED, checked**: its `local`-only guard bounds chain fanout from a replica on any forge. |
| 2026-08-25 | Issue #202 (the egress default). **INT-CONTAINER-RUNTIME-CONTRACT AMENDED**, one clause: the network flag is present unless `PI_EGRESS=0`, rather than only when it is `1`. **INT-EGRESS-POLICY-CONTRACT AMENDED**, the same clause plus the arming rule, which now lives in one place (`egress.mjs`) because the worker, `doctor` and `up` must not be able to disagree about the posture. **INT-SANDBOX-CONTRACT UNCHANGED, checked**: it inherits the flag through the builder seam either way. |
| 2026-08-25 | Issue #202 (the egress allowlist becomes a shipped control). **NEW `INT-EGRESS-POLICY-CONTRACT`**: the objects the policy IS on a host -- a per-job `--internal` network, a long-lived allowlist proxy publishing nothing, an upstream bridge, an operator-edited hostname list and a shipped rules file -- so the worker that builds it, the gate that checks it and the operator who edits it describe one thing. A SIBLING of `INT-CONTAINER-RUNTIME-CONTRACT` on the `INT-SANDBOX-CONTRACT` precedent. **INT-CONTAINER-RUNTIME-CONTRACT AMENDED**, three edits. The flag list gains `--network=pi-job-<jobId>-net` when `PI_EGRESS=1`, plus a sentence it has needed since `--memory`/`--cpus` were written into it: this is a list of FLAGS, not a rendering of `ISOLATION_FLAGS`, and three of its members are not in that constant. That is not clerical -- issue #202's own text said the change "touches `ISOLATION_FLAGS`", and following it literally would make this file's `:1104` sandbox assertion ("against the imported array, not a copy") and `CONST-ISOLATION-CONTAINER-PER-JOB`'s twin false for every deployment running without a policy, which does not weaken the assertion so much as retire it. A new per-flag sub-bullet records why the network and not the proxy is load-bearing, why it is PER JOB (a shared network is a shared L2 segment at `DES-CONCURRENCY-3`, and `enable_icc=false` cannot fix it because ICC blocks job-to-proxy along with job-to-job -- measured in both directions), and that the provider is an ordinary allowlist entry because the recorded finding that it could not be is REFUTED. And the `PI_OFFLINE=1` sub-bullet gains **one clause and nothing else**: it is the closest unconditional-narrowing precedent and the analogy does NOT carry, because offline costs an unarmed job nothing while an unconditional network flag would turn every job on a deployment that never started the proxy into an outage. **INT-SANDBOX-CONTRACT AMENDED**: a sandbox joins its own network by the same builder seam, its env grows by three variables, and its NO CREDENTIALS clause is untouched and was checked rather than assumed -- a proxy URL is not a credential and `buildContainerEnv` is still not reused. The preflight deliberately does not gate a sandbox: it is a money gate and a sandbox spends nothing. **INT-RUNNER-EXIT-CODE-PROTOCOL UNCHANGED, checked** -- the egress refusals are host-side policy returns that never reach a container, so no exit code gained a meaning. **INT-CONTAINER-JOB-INPUTS, INT-SESSION-STORE-CONTRACT, INT-OUTBOX-CONTRACT UNCHANGED, checked**: no mount, no file and no input crosses the boundary. **INT-TRIGGERS-FILE-CONTRACT UNCHANGED, checked**, deliberately and not incidentally: no `run.network` field exists, because a per-trigger egress relaxation is a per-trigger security downgrade. **INT-RUN-HISTORY-FILE-CONTRACT AMENDED**: two reason tokens, `egress-proxy-missing` and `egress-proxy-stopped`. |
| 2026-08-25 | Issue #208 (the App key had to be a file). **INT-CONTAINER-RUNTIME-CONTRACT AMENDED**, the `PI_FORWARD_ENV` refusal clause: `GITHUB_APP_PRIVATE_KEY` now exists as a configuration variable (the App's PEM supplied inline, for a deployment whose environment comes from a secrets manager rather than a file), and it is refused in the forward allowlist for a reason the existing clause did not cover. Every name refused before it is refused because a forwarded host value would OVERRIDE the per-job mint; this one overrides nothing and simply must not be in a container: it is the App's *signing* key, so it mints installation tokens for every repository the App is installed on, strictly broader than the credential `CONST-TOKEN-SCOPED-PER-JOB` bounds, handed to a process reading adversarial issue text. The hazard is CREATED by this change — while the key could only be named by a path, `PI_FORWARD_ENV` could carry nothing but that path — so the refusal lands in the same commit as the variable. The same edit un-staled the clause's enumeration, which named four of the eight minted variables the code has derived from the forge table since issue #42; it now says derived-not-enumerated and lists all eight. `GITHUB_APP_PRIVATE_KEY_PATH` is deliberately NOT refused, and the clause says why: a path with no mount behind it is inert in a container, and a refusal that fires on harmless things stops being read. **INT-CONTAINER-JOB-INPUTS UNCHANGED, checked** — no mount, no file, nothing new crosses the boundary; the key reaches the worker's own process and stops there. **INT-RUNNER-EXIT-CODE-PROTOCOL UNCHANGED, checked** — a malformed inline key is a config refusal at load, which is the boot path, not a job exit. **INT-SDK-SESSION-OPTIONS, INT-SANDBOX-CONTRACT, INT-RUN-HISTORY-FILE-CONTRACT UNCHANGED, checked** — no session option, no sandbox variable (a sandbox carries no credential at all, now pinned against this name too), and no record field. |
| 2026-08-25 | Issue #199 (egress). Prose correction, no contract change: `INT-STAGED-PACKAGE-CONTRACT` said host staging is what lets a job load third-party extensions "with egress denied", and nothing denies egress — the job argv carries no `--network` and `OQ-004` is explicit that a job container reaches the internet. What staging plus `PI_OFFLINE=1` actually buys is that there is no job-time install, which is what the sentence now says; the staged-layout line drops the same "no network at job time" phrasing for "no registry fetch at job time". `INT-CONTAINER-RUNTIME-CONTRACT` **UNCHANGED, checked** — its pinned flag list is untouched, and the egress policy `docs/sandbox.md` documents is applied by the operator around the container. |
| 2026-08-13 | Issue #189 (closing pass: package prompt templates, OQ-019 deferral (b)). **INT-SDK-SESSION-OPTIONS AMENDED**: the loader gains `additionalPromptTemplatePaths` (the overlay's `prompts/`, existsSync-gated, merged after discovery so the repo's `.pi/prompts` still wins first-path-wins) and `promptsOverride` (repo-wins-on-conflict ENFORCED for templates -- pi merges package prompt paths first and dedupePrompts is first-wins, the same inversion `skillsOverride` closes; the protected set is PRE-LOADED by a second minimal DefaultResourceLoader because no per-dir prompt loader is exported at the pin and the exports map is closed -- pi's own reader through its public surface, built only when packages are staged so the common job pays nothing). The `packages_loaded` line grows per-root `prompts`/`themes` counts, and a new post-session `commands_registered` line counts what the ExtensionRunner actually registered per root, names only. **INT-CONTAINER-JOB-INPUTS UNCHANGED, checked** -- no mount, no env var, no new input crosses the boundary. **INT-PI-PACKAGES-FILE-CONTRACT UNCHANGED, checked** -- what a package may declare is untouched; what happens to it in-container gained precedence and visibility. |
| 2026-08-13 | Issue #189 (Gap 2, producer half: `run.command` in the triggers file, and the chain refusal). **INT-TRIGGERS-FILE-CONTRACT AMENDED**: `run.command` joins all four entry shapes as the second entry point — EXACTLY ONE of `run.flow`/`run.command`, refused at parse in both services in both directions (both present, neither present); the value validated at parse exactly as the runner validates `PI_COMMAND` (non-empty, no leading slash, no surrounding whitespace, no control characters), so a value that loads never refuses in-container; the prompt contracted as EXACTLY `/<command> [args]` for local AND forge jobs (no envelope, no pointer, no trailing newline), delivery context reaching the handler only via `event.json` — `CONST-ISSUE-TEXT-IS-DATA` held and arguably strengthened, since nothing payload-authored renders into a command prompt at all; args STATIC from the reviewed file with `event.json` the dynamic channel; `run.task`, `run.instructions` and `run.resume: true` each refused beside it for its own recorded reason while the box-configuring fields stay orthogonal; the comment `<phrase> <flow>` override INERT on a command rule and `knownFlows` built from flow-carrying rules only; never AI-reachable (`chain-command-refused`; `dispatch_run` structurally incapable plus a readable slash-leading-flow refusal; no `command` parameter on `dispatch_trigger_add`/`_edit` — `run.image`'s no-model-callable-path clause applied to the entry point itself); the forge dedup key `cmd:`-prefixed in the flow slot; the `commands` capability enforced worker-side pre-spend (`job-image-commands-unsupported`, the `replicas` pattern); doctor reports command counts advisory-only. **INT-OUTBOX-CONTRACT AMENDED**: the `command` key becomes the ONE read-and-refused exception to unknown-keys-ignored — refused as `chain-command-refused` before the charset check, no opt-in, because a command prompt is BUILT at the producers and no committed artifact exists for a gate to read; commands may chain OUT, nothing chains INTO a command. **INT-CONTAINER-JOB-INPUTS previously amended (runner half), re-checked** — `PI_COMMAND`'s omit-when-absent shape and its strict validation are exactly what the new parse-time rules guarantee never fires; nothing further crosses the boundary. **INT-RUNNER-EXIT-CODE-PROTOCOL previously amended (runner half), re-checked** — the three command reasons stand untouched; this half's new vocabulary (`chain-command-refused`, `job-image-commands-unsupported`) is host-side refusal reasons, never exit classifications. |
| 2026-08-13 | Issue #189 (Gap 2, runner half: dispatch a registered extension command headlessly). **INT-RUNNER-EXIT-CODE-PROTOCOL AMENDED**: three named reasons under the EXISTING codes, never a new code or worker outcome — `command-unregistered` (2, pre-prompt `getCommand()` refusal, foreclosing pi's fall-through of an unregistered `/name` into a paid model call), `command-completed` (0, a clean headless return that was previously the retryable `no-terminal-message` shape re-billing a success), `command-error` (1, a handler throw pi swallows and only `extensionRunner.onError` surfaces; retryable BY EXPLICIT CHOICE, recorded with its accepted cost on the new `DES-COMMAND-ENTRY-POINT`); a handler-driven terminal keeps its ordinary stopReason verdict, and budget aborts keep first position. **INT-CONTAINER-JOB-INPUTS AMENDED**: `PI_COMMAND` joins the worker-passed env (omit-when-absent; strictly validated runner-side — no leading slash, no surrounding whitespace, no control characters — because dispatch grammar passes everything after the first space verbatim as args); the runner rebuilds the prompt from THIS variable, `prompt.md` staying the byte-identical human record. The `commands` capability joins the image label so the worker can refuse a command job on an older runner pre-spend (the `replicas` pattern; worker-side gate lands with the producer change). **INT-TRIGGERS-FILE-CONTRACT UNCHANGED, checked** — `run.command` itself is the producer half and lands with it; nothing here reads the triggers file. |
| 2026-08-13 | Issue #189 (Gap 1, doctor half: per-trigger flow-tier resolution lines). **INT-TRIGGERS-FILE-CONTRACT UNCHANGED, checked** — no new trigger field and no validation change; doctor reads the parsed file it already read, now carrying per-trigger (flow, folder, skillsDir, packages) tuples instead of only deduped sets. **INT-CONTAINER-JOB-INPUTS UNCHANGED, checked** — nothing new crosses the container boundary; the doctor lines are host-side only. **INT-PI-PACKAGES-FILE-CONTRACT UNCHANGED, checked** — the stage manifest's shape is untouched; `readStagedSkills` layers a never-throws skills enumeration over `readStageManifest` without reading any new field. |
| 2026-08-13 | Issue #189 (Gap 1, runner half: a `run.flow` that resolves in no skill tier is a silent exit-0 no-op). **INT-CONTAINER-JOB-INPUTS AMENDED**: the worker-passed env gains `PI_FLOW` — the trigger's `run.flow` verbatim, forwarded ONLY when the job carries a flow, omitted for a bare `run.task` cron job, never an empty string (the `PI_PACKAGES`/`PI_SESSION_FILE` omission shape). It is the flow's STRUCTURAL copy beside the existing prompt prose, read by the runner to compare against the loaded skill set and emit `flow_not_loaded` on a miss; it rides env and not `event.json` because an execution knob is not a fact about the delivery (the `run.replicas` line), and the runner takes no charset opinion on it (compared and logged, never interpolated — a runner stricter than the shared validator would fail yesterday's jobs on an image upgrade). **INT-RUNNER-EXIT-CODE-PROTOCOL UNCHANGED, checked** — the miss is one advisory log line before any session exists; no new exit code, no new reason, and the job proceeds (`DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS` records why report-not-refuse). **INT-TRIGGERS-FILE-CONTRACT UNCHANGED, checked** — no new trigger field; `run.flow`'s validation is untouched. **INT-WEBHOOK-PAYLOAD-SUBSET UNCHANGED, checked** — the variable carries operator config, never payload text. |
| 2026-08-11 | Issue #54 (Gap 2: a forge run's record could not be attributed to the `triggers.json` entry that fired it). **INT-RUN-HISTORY-FILE-CONTRACT AMENDED**: two additive, nullable fields on the replica fields' precedent — `triggerIndex` (the raw triggers-array index of the winning entry, cron entries counted) and `triggerType` (that entry's `on.type`) — explicit literals read from the job's own `data.trigger.matched` by the same no-spread `buildRecord`. An integer and a fixed enum, the admissible class the record already holds; the third `matched` key (`label`/`phrase`/`action`) is deliberately NOT persisted, because a label that satisfied an `any` predicate is collaborator-applied payload text and this record's PII-free property rests on holding no attacker-chosen string. Cron records keep `null` for both on purpose: a cron job's attribution is already exact via the `repeat:<id>:<millis>` jobId join, which also reaches records written before these fields existed, where a new field cannot. Persisting `matched` was deferred by issue #49's own no-new-record-fields scope, not by this record's posture; issue #54 is the consumer that makes it earn its place. Acceptance pins index `0` persisting as `0`, never `null`. **INT-CONTAINER-JOB-INPUTS AMENDED**: one cross-reference — `matched` remains event.json-only inside the container and never enters the prompt; its `index`/`type` alone are now also persisted host-side. **INT-WEBHOOK-PAYLOAD-SUBSET UNCHANGED, checked**: `matched` is harness-computed metadata, not a payload field, so the subset is untouched. **INT-OUTBOX-CONTRACT UNCHANGED, checked**: chained children carry no `trigger` and record `null`/`null`, exactly as manual runs do. |
| 2026-08-09 | Follow-up audit after issue #60. **INT-SDK-SESSION-OPTIONS AMENDED**, a correction rather than an addition: the option block still showed the TWO-path `additionalSkillPaths` literal, while the prose beside it had already been updated to three protected roots. A contract block that disagrees with its own note is worse than either being wrong alone, since a reader checking the code against the spec would have found the spec confirming the old shape. Now shows repo, injected, overlay. No behaviour changed; the literal had been stale since the injected tier landed hours earlier. |
| 2026-08-09 | Issue #60 (Gap 3: `run.instructions`). **INT-TRIGGERS-FILE-CONTRACT AMENDED**: a new optional field on the three webhook types, refused on cron with a message naming `run.task`, capped at 2000 characters and refused rather than truncated. Surrounding whitespace is deliberately NOT refused here, unlike `run.image`, and the divergence is recorded: that rule exists because whitespace changes what an image REFERENCE means, and it does not change what prose means. **INT-CONTAINER-JOB-INPUTS AMENDED**: `prompt.md` may now carry an operator standing-instruction block in the envelope above the data region; it reaches no other file. **INT-WEBHOOK-PAYLOAD-SUBSET UNCHANGED, checked**: the field is operator config and is not a webhook body field, so the subset is untouched and the value never appears in `event.json`. |
| 2026-08-09 | Issue #60 (Gap 2: `run.skillsDir`, a per-trigger operator skills directory). **INT-TRIGGERS-FILE-CONTRACT AMENDED**: a new optional field on all four run kinds, with the validation SPLIT written out because both halves are load-bearing. Existence is not checked in the shared validator because BOTH services parse this file and the receiver may run on another host (the `run.folder` precedent); absoluteness is not checked there either, and that one is subtler, because `path.isAbsolute` is OS-dependent, so a shared check would let a Windows worker and a Linux receiver disagree about the same reviewed file. The worker enforces both where the answer is knowable: at boot for cron, and pre-spend per job for every kind. Also records that the value never reaches `/job/event.json` (it rides at JOB level, never inside `trigger`, which is what the subset is built from), and that injected skills are trigger-reachable and never AI-reachable. **INT-CONTAINER-JOB-INPUTS AMENDED**: `/job/trigger-skills/<name>/**` joins the layout as the one `/job` input that does NOT come from git, with the asymmetry argued rather than left to be noticed -- `.pi/` is read by oid because the serviced repo is only maintainer-trusted and an attacker can shape that tree, while `run.skillsDir` is operator-authored deploy-time config named in a reviewed file, so what remains is the ordinary filesystem hazard and the copier answers it the same way (lstat never stat, regular files only, destinations rebuilt from validated segments, bounded). It arrives on the EXISTING `/job:ro` bind. **INT-RUN-HISTORY-FILE-CONTRACT AMENDED**: six `skills-dir-*` reasons. **INT-SDK-SESSION-OPTIONS AMENDED**: the protected-root list goes to three, `/job/pi/skills` then `/job/trigger-skills` then `/opt/pi-global/skills`, consulted in that order. **INT-CONTAINER-RUNTIME-CONTRACT UNCHANGED, checked** -- and this is the entry the change was designed around: no mount is added, no flag, no env var, so a job with an injected skills dir has a docker argv byte-identical to one without, pinned by a test. |
| 2026-08-08 | Issue #60 (Gap 1: a repo skill's supporting files were silently dropped). **INT-CONTAINER-JOB-INPUTS AMENDED**: the materialiser's allowlist accepted exactly `.pi/APPEND_SYSTEM.md` and `.pi/skills/<name>/SKILL.md`, so a skill shipping `references/`, `scripts/` or templates had those files dropped by a bare `continue` with no error anywhere. That is worse than it sounds, and the reason is upstream: at the 0.80.7 pin `core/skills.js` instructs the model to "resolve it against the skill directory", so the skill loaded, read correctly, and pointed the agent at files that were not in the container. A confidently wrong agent, not a failure. The entry now documents whole-directory materialisation, the split-and-validate-every-segment grammar that replaced the single regex (STRONGER than the fixed template it replaces, because any separator other than `/` survives inside a piece and is refused by the anchored charset, and `..` is refused by the leading-alphanumeric rule), the two-tier charset (the skill NAME keeps the lowercase-only `SKILL_NAME_RE` it shares with the flow gate; only the segments below it are case-insensitive, because `SKILL.md` and `README.md` are the point), the Windows device-name refusal, the documented skips, and the six caps with the refuse-before-write ordering. Three sub-decisions are recorded rather than left implicit. **A subtree declaring no `SKILL.md` anywhere beneath it is not materialised**, because pi registers a skill only where a literal `SKILL.md` exists, so those bytes could never be referenced and copying them would be a data-dump channel that never has to look like a skill; the test is "anywhere beneath" and not "at the root" because pi keeps recursing while a directory has no `SKILL.md`, and a root-only rule would have recreated this very defect one level down. **`100755` stays rejected**, so a skill's scripts are invoked as `bash script.sh`: `/job` is `:ro` and files land `0444`, so accepting the mode and writing `0444` anyway would accept what the repo asked for and silently strip it, while `0555` would have the worker grant execve on repo bytes. **A cap breach REFUSES the job** rather than truncating, because a truncated skill IS this defect and which files survived would be decided by git's tree order. The `/job/pi/extensions` bullet's PREMISE was rewritten (it asserted the materialiser "only ever emits ... SKILL.md", now false) while its CONCLUSION is untouched: `extensions/` is still never written, so discovery remains the only path a repo extension has ever had. Acceptance gains the symlink-inside-a-skill-subdirectory case and the cap cases. **INT-RUN-HISTORY-FILE-CONTRACT AMENDED**: four terminal reasons (`pi-too-many-files`, `pi-file-too-large`, `pi-too-large`, `pi-path-collision`), plus `sha-gone`, which the enum had always omitted. The `pi-` prefix is load-bearing rather than decorative: the nested `session.reason` enum already carries a bare `too-large`, and two enums in one record sharing a token is how a reader misattributes a refusal. **INT-SDK-SESSION-OPTIONS UNCHANGED, checked**, and the check is the interesting one: it has always written the layout as `.pi/skills/**/SKILL.md`, one level deeper than the code implemented, so the spec was right and the code has now caught up to it rather than the other way round. **INT-CONTAINER-RUNTIME-CONTRACT UNCHANGED, checked** — no mount, no flag, no env var; the widened content rides the `/job:ro` bind that already existed. Repaired in passing, because this change made it unavoidable: `makePrepareWorkspace` leaked its `mkdtemp`'d job dir on EVERY policy refusal, since a refusal carries no `jobDir` and both teardown paths guard on `prepared?.jobDir` — true of `sha-gone` since it shipped, and about to be hit on every delivery by a repo that breaches a cap. |
| 2026-08-08 | Issue #66 (ingest `pull_request_review`). **INT-WEBHOOK-PAYLOAD-SUBSET AMENDED**: `pull_request_review` joins the consumed events as a SECOND event name on one trigger type (`submitted` only; `edited` and `dismissed` drop as `unhandled-event`, since an edit re-fires on text already paid for and a dismissal withdraws a verdict rather than stating one), and the body-field list gains `review.{id, body, state, author_association}` — the PR fields need no addition, because the review payload carries the full PR object and the projection was always shape-gated rather than event-gated. Three clauses are normative rather than descriptive. **`review.state` is folded to lower case on projection**, because GitHub spells it `approved` on the webhook and `APPROVED` on `GET /pulls/{n}/reviews`, so without one fold point the identical review would produce two different jobs depending on transport and a polled `COMMENTED` would slip past the empty-body refusal; the parity test drives both spellings. **`review.user` is deliberately NOT consumed** — `sender.id` is the only identity the gate and the bot-loop guard read, and a login is PII with no reader. **`review.id` is consumed** because a review's inline comments ride `pull_request_review_comment`, an event this contract does not consume. That last one carries a correction to the issue's own framing, recorded because the record should not stay wrong: #66 justified `review.id` by the line-comments-only case, which is precisely the case the `no-review-body` refusal drops, so the id in fact earns its place on the `approved`/`changes_requested` reviews that carry inline comments AND fire — the residual is `OQ-021`. The **Why** gains the sentence the change actually needed: it said `pull_request.author_association` "gates only auto actions", which became false by omission, and it now states that `review.author_association` is the same class of field gating a DIFFERENT arm, with the reason the fields differ. The synthesized-subset clause gains `/pulls/{n}/reviews` and `poll-rv<review>`. Acceptance gains the two directional gate cases and the case-fold case. **INT-TRIGGERS-FILE-CONTRACT AMENDED**: the github action vocabulary goes to five with `review_submitted`, spelled as a compound so both halves stay greppable in GitHub's docs (the `label_updated` precedent) and riding `pull_request` rather than becoming a fifth `on.type`, because GitLab's `approved` already rides `pull_request` and a new type would have made one forge's review a type and the other's an action. Records that `approved` is NOT this word renamed — `approved` is one verdict, `review_submitted` is every verdict — which is exactly what the new optional **`on.reviewState`** narrows, github-only and legal only beside `review_submitted`, with four load-time refusals including that last one, because a `reviewState` beside `["opened","synchronize"]` reads as a narrowing and does the opposite. The stale claim that `approved` "has no GitHub counterpart at all" is removed here and in `docs/gitlab.md`. **INT-CONTAINER-JOB-INPUTS AMENDED**: "plus three additions" becomes four, `review` gets the data-by-placement clause `comment` has (body to the prompt, `id`/`state`/`author_association` to `event.json` only), and a new clause records that on a review-triggered job `matched.action` (`review_submitted`, the file's word) and the record's own `action` (`submitted`, GitHub's word) deliberately DIFFER — the first GitHub case where they do, which makes the existing "for `pull_request` the `action`" sentence read as the rule's action rather than the payload's. **INT-GITLAB-, INT-FORGEJO- and INT-AZURE-PAYLOAD-SUBSET UNCHANGED, checked** — no other forge reports a review verdict, and `on.reviewState` is refused on all three at load. **INT-RUN-HISTORY-FILE-CONTRACT UNCHANGED, checked** — `no-review-body`, `review-author-not-allowed` and `review-state-not-matched` are RECEIVER drop reasons, which are log fields and not the record's closed terminal-outcome enum. |
| 2026-08-08 | Issue #103, two records that disagreed with the code. **INT-RUN-HISTORY-FILE-CONTRACT**: the nested `session.reason` enum was documented as CLOSED while omitting `promote-failed`, which `promoteSession`'s outer catch returns on any fs fault during the swap and which `mergeSession` writes straight into the record on the completed path — a full disk would have produced a token the spec called impossible. Added, together with a producer table, because the enum reads as one flat list while three separate code paths write it (resolve, runner, promote) and a refused promotion WINS over the other two. Recorded three things the list cannot show: `expired` never arrives from the promote path, `promoted` is a return value that reaches no record, and `no-key` is deliberately NOT in the enum — a DI-seam backstop unreachable in a wired worker, since `sessionKeyFor` is total and binary so `resolveSession` returns `null` rather than a keyless session. Pinned by a new fault-injection test in `worker/test/session-store.test.mjs`. **INT-SDK-SESSION-OPTIONS**: the `additionalExtensionPaths` comment claimed operator-staged pi packages "ride this same option" as `PI_GLOBAL_ALLOW_EXTENSIONS`; the spread is and remains UNCONDITIONAL, so the comment was the defect, in both this file and `image/runner/src/loader.mjs`. Corrected to state the split and why (the worker applies `run.packages` before emitting `PI_PACKAGES`, so re-gating here would withhold what the operator armed), and the previously untested `allowGlobalExtensions: false` case is now pinned in `image/runner/test/loader.test.mjs`. **INT-SESSION-STORE-CONTRACT UNCHANGED, checked** — its write-path prose names no reason tokens, so the drift could only ever have been visible from the record's own contract. |
| 2026-08-07 | Issue #102: **INT-PI-PACKAGES-FILE-CONTRACT** records that `pi-packages.json` is now the override-and-addition layer rather than the only source (discovery reaches the same validator, so it adds candidates and never exemptions), and that the receipt gained `from` as a CLOSED enum with a default — which covers both compatibility directions at once, since a pre-#102 receipt carries no `from` and reads as declared while an older worker drops it as an unknown key. Also records that the receipt is now read at EACH job start rather than once at boot, why the boot read was right until discovery made re-staging routine, and why a failed read keeps last-known-good instead of degrading to none (an empty set emits no `PI_PACKAGES`, so the runner's path assertion would have nothing to refuse and the job would run toolless on a clean exit 0). **INT-CONTAINER-RUNTIME-CONTRACT, INT-TRIGGERS-FILE-CONTRACT, INT-CONTAINER-JOB-INPUTS UNCHANGED, checked** — the mount, `PI_PACKAGES`, `run.packages` and the pre-spend refusal are all untouched; only who fills the manifest, and how often it is read, moved. |
| 2026-08-04 | Documentation audit fallout (issue #99). **INT-TRIGGERS-FILE-CONTRACT** amended on `run.resume`, which this file had described as carried on **ALL FOUR** kinds for a month while the wiring covered three: `resolveSession` is handed to the forge preparers only, so a cron job with the flag armed staged no transcript, mounted no `/session`, promoted nothing and exited `0` as though it had. That is the flag's own believed-on-while-off inversion reached through the wiring rather than through a truthy `"false"` string, so the fix is `run.replicas`' fix: **refused at load**, worded *not yet covered* rather than impossible, because `session-key.mjs` already derives the local key from the scheduler id and nothing reaches it. Only `true` is refused — `false` and absent still validate and still land in `data` byte-identically, since `false` is the documented default and refusing an operator for writing down present behaviour would also change a shape pinned as byte-identical; the asymmetry with `run.replicas` (which refuses ANY value on cron) is recorded rather than left to read as an oversight, `1` being a no-op flag where `false` is the truth. The same bullet gains the **pre-spend** half, which the triggers file cannot answer by construction: whether a session store exists is deployment state, not file content, so an armed trigger under a deployment with no `PI_SESSIONS_DIR` is refused per delivery and `doctor` keeps the load-time warning. **INT-RUN-HISTORY-FILE-CONTRACT**: the `reason` enum gains one token, **`sessions-dir-unset`**, on `job-image-missing`'s precedent — a policy outcome with `budgetReserved: false`, since it is answered from two values already in hand before the mint, the branch check, the clone, the token-cap read and the budget INCR. Its shape follows `settings-overlay-invalid`'s (`<config artifact>-<its bad state>`) and its words are the spec's own, so the token greps to the text that mandates it. The nested `session.reason` enum's **`disabled`** was audited as unimplemented and is **UNCHANGED, checked**: the runner produces it (`image/runner/src/session.mjs`) whenever no session file is mounted, which is every unarmed job, so the entry was right and the audit finding was wrong. **INT-SESSION-STORE-CONTRACT UNCHANGED, checked**: the store's own no-`sessionsDir` return is now unreachable in a wired worker and kept as the DI-seam backstop, which changes no byte of its contract. |
| 2026-08-04 | The panel learns to find a deployment built elsewhere (issue #92). Added **INT-DEPLOYMENT-POINTER-CONTRACT**: `<agent dir>/pi-dispatch-deployment.json` (override `PI_DISPATCH_DEPLOYMENT_FILE`), an allowlisted absolute-paths-only env map layered UNDER the operator's env once at extension load — env wins key by key, the worker/receiver never read it, and `PI_DISPATCH_RUN_ROOTS`/credentials in the file have no effect by construction (a pointer that widened the AI-run allowlist would be a second unreviewed door to a gated capability). Deliberate divergence from INT-SUBSCRIPTIONS' loud version refusal, recorded in the entry: a broken/newer pointer degrades to exactly the pre-pointer behavior with a one-line surfaced notice, never a throw — the read-model's never-throw doctrine outranks fail-loud here because the pointer is an availability aid, not a data file. **INT-SUBSCRIPTIONS-FILE-CONTRACT / INT-CONFIG-OVERLAY-CONTRACT UNCHANGED, checked**: the pointer changes how their Locations are *found*, not what the files contain. |
| 2026-08-02 | Polling producer (issue #81). **INT-WEBHOOK-PAYLOAD-SUBSET** amended: the subset may be synthesized from REST objects by `pi-dispatch-receiver poll` (`DES-GH-POLLING-TRANSPORT`), feeding the same pure `filter()` — parity pinned by dual-form tests; `poll-*` delivery ids share the `gh-` dedup space disjointly; the headers/HMAC row explicitly does not apply to synthesized subsets (no inbound delivery exists — TLS + the operator's credential is the transport trust). **REQ-DEDUP-BY-DELIVERY-GUID UNCHANGED, checked**: poll ids are stable across poller restarts by construction (event id / comment id / PR+head-sha), which is the retry-stability property the REQ demands of any id source. **INT-GITLAB/FORGEJO/AZURE-PAYLOAD-SUBSET UNCHANGED, checked**: polling is GitHub-only in this slice. |
| 2026-08-02 | Receiver start path + triggers-default unification (issue #80). **INT-TRIGGERS-FILE-CONTRACT** amended: the receiver no longer *requires* `PI_TRIGGERS_FILE` — it falls back to `./triggers.json` in its working directory, the exact file `pi-dispatch init` scaffolds, and refuses to start when neither exists. The old default was the committed `deploy/triggers.json` (live demo triggers): an operator who edited the init scaffold and started the receiver without the env var silently ran the demo rules — a cwd default makes the reviewed file the operator just edited the one that fires. The admin extension's `resolvePaths` moves to the same cwd defaults for triggers/pause-windows/subscriptions (**INT-SUBSCRIPTIONS-FILE-CONTRACT** Location updated; **INT-PAUSE-WINDOWS-FILE-CONTRACT** UNCHANGED, checked — its Location is env-or-off for the *worker*, and the admin default is not part of that contract's shape). The receiver also gains its own bin, `pi-dispatch-receiver` (`receiver/src/cli.mjs`, `serve` by default): a `receiver` case in the worker CLI would invert the receiver→worker workspace dependency, and until now the only start command on record was inside `deploy/receiver.service`. **INT-WEBHOOK-PAYLOAD-SUBSET UNCHANGED, checked**: the bin changes how the process starts, not what it accepts or enqueues. |
| 2026-08-01 | Pricing façade (issue #53, gaps 4/5 groundwork). Added **INT-PRICING-EXPORT-CONTRACT**: the worker's `./pricing` export is the admin's ONLY road to pi-ai's rate tables — `listPricedModels`/`getPricedModel`/`isZeroRated`/`piAiVersion`/`reprice`. Stream-time cost on the record stays the metered truth; the façade prices COUNTERFACTUALS only. `reprice` builds a fresh `Usage` with a zeroed cost skeleton every call (pi-ai's `calculateCost` mutates in place and TypeErrors without one — both pinned by test), inherits pi-ai's tier selection and 1h premium, and makes exactly one judgment: `cacheWrite1h` forwards only to `anthropic` targets, folded short for everyone else, because the premium is an Anthropic billing rule and applying it elsewhere would invent cost. The admin deliberately does NOT grow its own pi-ai pin (a fourth pin, a second drift axis); enumeration goes through the side-effect-free `providers/all`, never `./compat`. Enforcement is the pinned-artifact guard in `worker/test/pricing.test.mjs` — a pin bump that reshapes pricing fails the BUILD, not the screen. |
| 2026-08-01 | Per-(provider,model) usage ledger (issue #53, gap 1). **INT-RUN-HISTORY-FILE-CONTRACT** amended: the record gains `usage` (the ledger block: `v`/`piAi`/`truncated` + up to 8 named rows and one `other` row carrying the full cache split each call's `Usage` always had but the flat totals collapse) and host-effective `provider`/`model` — all three additive and nullable. The entry records the load-bearing shape decision: `usage` is a **sibling of `tokens`, not a widening**, for the same reason `parseExitSession` was — `tokens` may ride through verbatim only because it holds nothing but numbers, while the ledger carries container-emitted id STRINGS, so `parseExitUsage` rebuilds a narrowed object (lowercased, `^[a-z0-9][a-z0-9._:/-]{0,63}$`, whole-block-null on any violation) and the record's PII-free-by-construction property survives. `provider`/`model` are host-side dispatch facts threaded through every terminal result/error object including `InfraRetry` (which also gains the `session` field its constructor silently dropped — a latent loss on infra-retry records, repaired in passing), so catch-path deaths still attribute. `piAi` stamps rate-table provenance: history is priced once, never silently repriced. **INT-RUNNER-EXIT-CODE-PROTOCOL** amended with one paragraph: `usage` is read-only telemetry and feeds classification exactly as much as `tokens` does — not at all. `parseExitTokens` and the `tokens` shape are **UNCHANGED, checked** — the widening precedent explicitly does NOT extend to blocks carrying strings. **INT-CONFIG-OVERLAY-CONTRACT UNCHANGED, checked**: the ledger reads the overlay's resolved values through `effectiveSettings`, adding no key. |
| 2026-08-01 | Operator-declared subscriptions (issue #53). Added **INT-SUBSCRIPTIONS-FILE-CONTRACT**: the operator-authored `subscriptions.json` (`PI_SUBSCRIPTIONS_FILE`, admin default `deploy/subscriptions.json`) declaring what subscription-backed providers actually cost — their rate tables are all zeros, so runs record cost 0 and read as free when they are prepaid, and the env boundary refuses OAuth/subscription logins by design, leaving the operator declaration as the only honest price source. Counterfactual arithmetic only: the worker exports the shared `parseSubscriptions` validator and reads nothing at job time; the admin is the sole reader/writer (validate-then-tmp+rename, repairs a broken file). `version` is required and a HIGHER version is refused loudly naming both versions — fail-loud-on-newer cannot be retrofitted; `null` window `unit`/`limit` is first-class "vendor undisclosed", rendered as unknown, never an invented burn-down. **INT-CONFIG-OVERLAY-CONTRACT UNCHANGED, checked**: subscriptions get their own operator file, not overlay keys — the overlay is runtime tuning with fail-closed job-start semantics, and prices are bookkeeping. The env-allowlist OAuth/subscription refusal **UNCHANGED, checked**: declaring a plan never admits its login. |
| 2026-08-01 | Replica runs (issue #56). **INT-TRIGGERS-FILE-CONTRACT** amended with **`run.replicas`** (github `label`/`comment`/`pull_request` only, integer `2..3`) — the only field in this file that MULTIPLIES SPEND, so every refusal is spelled out with its own reason rather than as one range check: a `local`/cron trigger is refused because its `/workspace` IS the operator's folder, bind-mounted rw, where a forge job gets its own `mkdtemp`'d clone; a non-github forge is refused as *not yet covered* rather than impossible, since every forge mints its branch through the same `issueBranch`; `1` is refused rather than accepted-and-ignored, because a one-member replica set is a field that does nothing and *accepted-and-ignored is how an operator comes to trust one that does*; `3` is the ceiling because `PI_CONCURRENCY` defaults to 3 and a fourth replica would queue rather than race; and `run.resume: true` is refused alongside, naming both fields, because that refusal is the ONLY reason `session-key.mjs` may keep deriving from the unsuffixed branch. The delicate half is recorded explicitly: the **semantic dedup key gains `:r<i>` only when a replica is set**, so re-deliveries of each replica still coalesce while replicas never coalesce against each other — and distinct job ids alone would NOT have sufficed, since a duplicate `queue.add` under a taken id is *silently ignored* and the second replica would vanish with no error surface. Acceptance gains the byte-match clause for `data` **and the dedup id**, the four load refusals, the two-jobs-one-delivery clause, and the 503-partial-failure clause (the retry converges on exactly *n* jobs because the queued ones dedup on their own now-taken ids). **INT-RUN-HISTORY-FILE-CONTRACT** amended: `replica`/`replicas`, additive and nullable **on the chain fields' precedent**, and the entry states WHY they are admissible at all — they are host-assigned INTEGERS, so the record's PII-free-by-construction property is untouched, and the branch name they imply is deliberately absent for the same reason `session` omits its key. The `reason` enum gains one token, `job-image-replicas-unsupported`. **INT-CONTAINER-RUNTIME-CONTRACT** amended: `dev.pi-dispatch.capabilities` joins the conformance checklist, and its **polarity is the OPPOSITE of `dev.pi-dispatch.forges`** — stated on the record because that asymmetry reads as a bug later. `forges` is an EXCLUSION list, so no claim excludes nothing; `capabilities` is an INCLUSION list, so no claim includes nothing and an unlabelled image is refused every replica job. The failure it prevents is the quiet one this list exists for: a pre-feature image bakes a `HARD_RULES.md` naming `pi/issue-<n>` as a SYSTEM rule, which overrides the user prompt naming `-r2`, so both replicas converge on one branch, nothing errors, and the operator pays twice for one pull request. `verify-image.sh` greps the baked guardrails when the label claims `replicas`, so it cannot lie any more than `forges` can. **INT-CONTAINER-JOB-INPUTS** and **INT-WEBHOOK-PAYLOAD-SUBSET UNCHANGED, checked, and the check is the point**: `event.json` is a deliberate literal of the webhook's own body plus one decision record, and an execution knob is not a fact about the delivery — the agent learns its index from the prompt and `PI_JOB_ID` already ends `-r2`, so nothing there needed to move. Recorded as a rejected alternative in `DES-REPLICA-INDEX-REACHES-THE-BRANCH`, not as an oversight. **INT-OUTBOX-CONTRACT UNCHANGED, checked**: its `local`-only guard already closes chain fanout, and a replica is always a github job. **INT-SESSION-STORE-CONTRACT UNCHANGED, checked**: a replica job can never carry `run.resume`, so no replica reads or writes a transcript. |
| 2026-08-01 | Added **`INT-SANDBOX-CONTRACT`** (issue #55, `REQ-RESURRECTABLE-SANDBOX`) — the operator-session container shape, plus the retained-directory layout and its manifest. **A SIBLING of `INT-CONTAINER-RUNTIME-CONTRACT`, not an amendment to it**, and the reasoning is the same one `INT-GITLAB-PAYLOAD-SUBSET` recorded: IDs are permanent addresses, and a container an operator opens with no agent in it is a different object, not more of the job one. That entry is **UNCHANGED, and was checked rather than forgotten** — its `No TTY (-it absent)` line still describes every container the harness launches, which is precisely why the new shape needed its own address instead of a qualifier on that one. Three decisions written down because a later reader would otherwise re-litigate them: the sandbox argv comes from `buildDockerRunArgs` through the previously-unused `extraFlags` seam, so the isolation flags are inherited **by construction** rather than re-listed; the retained-directory manifest is a **separate file from the run-history sidecar**, because `INT-RUN-HISTORY-FILE-CONTRACT`'s PII-free-by-construction property is what lets the admin extension feed those records to a model and this one holds a host path (that entry likewise **UNCHANGED and checked**); and expiry reads the manifest's `createdAt` rather than mtime, inverting `makeLogReaper`'s documented "mtime is the authority" for the one case where it fails — an operator working inside a sandbox moves mtime, so the window would never close. `INT-SESSION-STORE-CONTRACT` **UNCHANGED, and checked**: the per-job `/session` copy is deleted **before** retention, so no transcript ever enters a directory whose lifetime `--pin` can extend. |
| 2026-07-28 | **The pi-normal discovery posture** (`CONST-NO-CONTEXT-FILES-MANDATORY`, amended in the same change). **INT-SDK-SESSION-OPTIONS**: the contract block showed all three suppression flags `true` and was two flags and two options behind the runner — it now mirrors the shipped loader (`noContextFiles: false`, `noExtensions: false`, `noSkills: true`, the `settingsManager`, `extensionsOverride`, and the `outboxProtocol` entry in `appendSystemPromptOverride` that a local job's `/outbox` mount adds). Trap **(c)** rewritten from "`noContextFiles: true` is the SDK equivalent of `-nc`, and it is OFF BY DEFAULT" to the amended posture, keeping the point that the value is written out **because** it is the decision on the record, and naming the inverted trap it leaves (the loader is not forgiving elsewhere). Trap **(f)** rewritten and this is the correction worth reading twice: it said "Project trust is never granted, and is not needed", which conflated *we never call `resolveProjectTrust`* (true) with *the project is untrusted* (false — `SettingsManager.fromStorage` takes `options.projectTrusted ?? true` and `inMemory` forwards no options). The distinction was **inert** while both discovery flags were `true` and is now **load-bearing**: that default is exactly what makes `addAutoDiscoveredResources`' `if (projectTrusted)` branch load `/workspace/.pi/extensions`, so if a future pi flips it, repo extensions stop loading **silently** — which is why the loader tests pin the outcome (the factory ran) and never the flag. Trap **(e)** flagged as MORE reachable, not historical. Two new traps: **(j)** the `extensionsOverride` recursion guard — two signals (entry-NAME pattern, and the `^dispatch_` TOOL-SURFACE check that actually catches this repo's `.pi/extensions/dispatch.ts`), applied before the loader stores the set so a dropped extension registers no tool and receives no event, with the honest limits recorded (the factory has already run; a repo's own `dispatch_*` tool is lost, logged and rename-able; a renamed re-export under other tool names is out of reach); **(k)** why `noSkills` STAYS `true` — mechanical, not caution: discovery double-registers every repo skill under `/workspace/.pi/skills` ahead of `additionalSkillPaths` and first-path-wins demotes the pinned-sha read-only mount to a collision diagnostic. Acceptance inverted to match (the `AGENTS.md` sentinel must now be **present** in `getAgentsFiles()` and **absent** from the append block), and a pinned-artifact evidence block added for the trust default and the two merge branches. **INT-CONTAINER-JOB-INPUTS**: a new bullet for what the container now reads from `/workspace` (`AGENTS.md`, `.pi/extensions`) and why neither is a `/job` input; the "why materialise" rationale re-grounded — it had claimed the checkout "for a PR-triggered job may be a fork", which `prepare-github.mjs` contradicts (always the base repo's default-branch sha, detached), so the surviving reasons are `:ro` untamperability and symlink-safety, both independent of trust. **INT-TRIGGERS-FILE-CONTRACT**: `run.packages` inverted to an **opt-OUT** (absent or `true` load; only `false` withholds), recording that the strictness which used to live in the worker's `=== true` moved to `parseTriggers`' load-time boolean validation, and that the damaging misreading flipped from a truthy `"true"` arming a trigger to a `"false"` string that looks like an opt-out and is not one. |
| 2026-07-28 | **Corrected INT-SDK-SESSION-OPTIONS trap (g)**, which the row below stated as a flat, unconditional fact ("pi-ai is installed TWICE"). It is not unconditional — it is a property of the **install**, not of pi. The dual layout appears wherever the **worker's** dependencies are installed as well (a dev checkout, the contract-tests job), because the hoisted copy IS the worker's declared dependency, and that layout is what makes a bare specifier bind the wrong registry and meter nothing while reporting success. The **job image** installs the **runner's** dependencies only (`image/runner/package.json` declares `@earendil-works/pi-coding-agent` and `@playwright/cli`, never pi-ai), so there the nested copy is the ONLY copy and the same bare specifier does not resolve at all — `ERR_MODULE_NOT_FOUND`, not a wrong binding. The trap now leads with the invariant that holds in BOTH and is the thing worth remembering: **never reach pi-ai by bare specifier** — register through `modelRegistry.registerProvider` and let the **runtime mutation probe** decide which module object the registry actually writes to — and records that `resolvePiAiCompat` wraps **both** lookups in `tryResolve` for exactly this reason, so an unresolvable candidate is skipped rather than thrown and one implementation is correct in both environments. Found by the `image` CI job, whose pi-ai step asserted the dual layout *inside the container* and failed there while the code it was guarding was correct in both places; that step now runs `resolvePiAiCompat` inside the built image and asserts the NESTED copy is offered first with the compat surface the probe and the wrapper need, and the dual-copy fact stays pinned by `image/runner/test/pinned-api.test.mjs` in the contract-tests job, which is the environment where it is true. |
| 2026-07-28 | Process-wide metering + operator-staged packages (issue #58). **INT-SDK-SESSION-OPTIONS**: the contract block now mirrors the shipped wiring — a HOISTED `sessionManager` so `rootSessionId` exists before the meter, the meter installed after `ModelRegistry.create` and before `createAgentSession`, a deterministic `arm()` after it (extensions register their own api providers during the call), `packagePaths` appended LAST to `additionalExtensionPaths`, and a `skillsOverride` that re-imposes protected-root skill precedence. Three new traps: **(g)** pi-ai is installed TWICE with separate module-level registries and pi-coding-agent uses the NESTED one, so a bare specifier binds the hoisted copy and meters nothing while reporting success — `import.meta.resolve` names the wrong path, and only a runtime mutation probe can decide it; **(h)** `resetApiProviders()` (what `AgentSession.reload()` calls) WIPES the registry, so registration goes through `modelRegistry.registerProvider` (which `refresh()` re-applies) plus a re-arm, and a wrapped entry is recognised by object identity because `refresh()` returns fresh objects; **(i)** skill precedence is decided by `skillsOverride`, NOT by path order — pi puts a staged package's skill paths first in `skillPaths` and `loadSkills` is first-path-wins, but the loader's declared `skillsOverride` runs on that result before anything is stored, and pi's public `loadSkillsFromDir` supplies the substitute, so `REQ-GLOBAL-PI-OVERLAY`'s "repo wins on conflict" is enforced rather than asserted. **INT-CONTAINER-RUNTIME-CONTRACT**: env gains `PI_PACKAGES` (conditional, fail-closed, `":"`-delimited container paths, omitted when empty) and `PI_OFFLINE=1` — flagged as the ONE env addition that is not opt-in, because it is a narrowing that makes pi's job-time `npm install` branch unreachable rather than merely unused; the `/opt/pi-global` sentence now names `packages/` as a fourth thing the overlay carries, and states that **the mount list itself is unchanged**. **INT-CONTAINER-JOB-INPUTS**: DELETED the `/job/pi/extensions/...` line — the materialiser only ever writes `APPEND_SYSTEM.md` and `skills/<name>/SKILL.md`, so it documented a path the worker never writes — with a note that the seam is kept deliberately (repo extensions are arbitrary merged-branch code and are not materialised), that it already yields a permanent unread `"path does not exist"` error on every job, and that this permanence is precisely why the staged-package existence check is scoped to package roots instead of surfacing pi's error list. **INT-TRIGGERS-FILE-CONTRACT**: `run.packages` (optional boolean) on all four `run` shapes with its own bullet mirroring `run.github`, and the cron byte-match acceptance extended for `packages` plus an explicit `PI_OFFLINE=1` env carve-out (same precedent as the cron `trigger:{id,pattern}` carve-out). **NEW INT-PI-PACKAGES-FILE-CONTRACT**: the `pi-packages.json` shape, the exact-version rule citing `CONST-PI-VERSION-PINNED`, the npm name charset, the `dir` sanitisation and uniqueness rule, the admin-name refusal, the `..`/absolute manifest refusal, the npm flag set with the reason for each, the staged layout, and `packages.json` as the never-throwing worker/doctor read model. The install target travels as the exec's **`cwd`**, not `--prefix`, so argv carries **no filesystem path at all** — recorded as a load-bearing safety property, because it is what makes the win32 `shell: true` (required since Node 18.20.2 refuses to spawn `npm.cmd` without one) safe: everything left in argv is a literal flag or a pre-validated `name@version`. **INT-RUNNER-EXIT-CODE-PROTOCOL**: the eight new `tokens` telemetry keys, restating that none of them feeds classification, plus a row for a process-wide breach mid-fanout (exit `2` / `token_budget`, deliberately the same row — one flag, one code). **INT-RUN-HISTORY-FILE-CONTRACT**: the widened `tokens` object, still additive and nullable-as-a-whole, noting `parseExitTokens` and `buildRecord` are unchanged and that `recordTokenSpend` now charges process-wide spend. |
| 2026-07-27 | Trigger context (issue #49): INT-CONTAINER-JOB-INPUTS — `/job/event.json` is now written for EVERY job kind, not only github. Local jobs get one of three `source`-discriminated shapes (`cron` with `trigger:{id,pattern}`, `scheduledFor`, and `previousRunAt`; `manual`; `chain`), each carrying the folder **basename** only (the full host path embeds the operator's OS account name and `/job` is agent-readable) plus the folder's HEAD `sha`. GitHub jobs gain `comment:{body,author_association}` for comment-triggered jobs — INT-WEBHOOK-PAYLOAD-SUBSET is UNCHANGED, both fields were already in its list; this is the first time they leave the receiver, still data-by-placement per CONST-ISSUE-TEXT-IS-DATA and never in worker logs or the run record — and a HARNESS-COMPUTED `matched:{index,type,label\|phrase\|action}` naming the raw triggers.json entry that fired (the filter's own decision record, not a payload field; never enters the prompt). `sender.login` deleted from event.json as written-but-never-populated — the subset extracts `sender.id` only, so the list is unchanged there too. INT-TRIGGERS-FILE-CONTRACT: the cron byte-match acceptance gains its one carve-out — scheduler `data` now carries a cron-only `trigger:{id,pattern}`, since `pattern` exists nowhere else at job time. INT-RUN-HISTORY-FILE-CONTRACT: the per-job `.json` files double as the `previousRunAt` lookup source — a read-only, filename-keyed scan, explicitly not a query surface, bounded by `PI_LOG_RETENTION_DAYS`. |
| 2026-07-27 | Closed the gh CLI gaps (issue #50): INT-TRIGGERS-FILE-CONTRACT's cron `run` gains an optional boolean `github` — absent/false = no token (the zero-GitHub default), `true` = the worker mints the SAME per-job token the GitHub path mints; a non-boolean value is refused at load, and `GITHUB_AUTH_SOURCE=app` refuses at mint time, since an installation token is per-repo and a local job has no repo to scope it to. INT-CONTAINER-RUNTIME-CONTRACT: the minted value is now injected as BOTH `GITHUB_TOKEN` and `GH_TOKEN` (gh prefers `GH_TOKEN`; mirroring forecloses precedence surprises), and both names are refused in the `PI_FORWARD_ENV` allowlist at config load — a forwarded operator token would otherwise silently override the minted one. Documented the `source:gh` trade-off next to `CONST-TOKEN-SCOPED-PER-JOB`: per-job scoping is the App path's property (a fine-grained PAT approximates it for a single owner); `gh` hands the operator's full-scope login to every token-carrying job, `doctor` names the actual scopes, and the operator's `~/.config/gh` is never mounted into a container. |
| 2026-07-22 | Unified triggers (issue #20 + `pull_request` triggers): replaced INT-SCHEDULES-FILE-CONTRACT with **INT-TRIGGERS-FILE-CONTRACT** — one `triggers.json` of `{ on, run }` entries via `PI_TRIGGERS_FILE`, read by both worker (`on.type:cron`) and receiver (`label`/`comment`/`pull_request`), with the `on × run` diagonal enforced fail-loud at load. Expanded INT-WEBHOOK-PAYLOAD-SUBSET to consume the `pull_request` event and its fields (`number`/`title`/`body`/`author_association`/`labels[].name`/`head.{ref,sha,repo.full_name}`/`base.ref`) plus `issue.pull_request` as a presence marker — `head`/`base` are attacker-controlled DATA, never a clone ref. Amended INT-CONTAINER-JOB-INPUTS: `/job/event.json` now carries an `issue` OR a `pull_request` body per the job-data `target` discriminator. See `DES-TRIGGERS-UNIFIED-FILE`, `DES-PR-TRIGGER-ROUTES-TO-FLOW`. |
| 2026-07-22 | Corrected INT-CONTAINER-RUNTIME-CONTRACT's mount-mechanism sentence: the `/job:ro`, `/workspace:rw`, and local-only `/outbox:rw` mounts are host bind mounts (`-v host:container`), not the superseded named-volume + `volume-subpath` mechanism. Aligns the INT with `DES-WORKER-ON-HOST` and the shipped `worker/src/docker-run.mjs`. Also corrected INT-RUN-HISTORY-FILE-CONTRACT's `chainRefused` annotation from `<bool>` to `<int>` (a count of refused `/outbox` requests on the parent; `0` = none), matching the shipped `buildRecord`, which stores the collector's running `refused` count verbatim. |
| 2026-07-21 | Extended INT-CONFIG-OVERLAY-CONTRACT's write protocol: an invalid existing file is repaired by the next write, which rebuilds from scratch with the sanitized candidate and surfaces a loud key-only notice — the fail-closed guarantee is stated to live only on the worker's job-start read. |
| 2026-07-22 | Added INT-OUTBOX-CONTRACT (container→worker `/outbox` request files: `request-<n>.json` byte-capped at 4 KiB, `folder`-ignored same-folder-only, validation order count→size→regular-file→parse→charset→host-computed depth→`ai-trigger` gate→enqueue, retry-idempotent child ids, completed-only collection, no mount for github parents, `task` as DATA never in the run record). Extended INT-CONTAINER-JOB-INPUTS and INT-CONTAINER-RUNTIME-CONTRACT with the writable `/outbox` mount (local jobs only; absent for github). Appended `parentJobId`/`chainDepth`/`chainRefused` (additive, nullable, no-spread) to INT-RUN-HISTORY-FILE-CONTRACT's record — the `reason` enum untouched, since a chain refusal is pre-enqueue of the child. |
| 2026-07-21 | Added INT-CONFIG-OVERLAY-CONTRACT (admin extension → worker `settings.json` overlay: optional keys with bounds, atomic tmp+rename write, per-job-start read, fail-closed `settings-overlay-invalid` on a present-but-invalid file). Reworded INT-RUN-HISTORY-FILE-CONTRACT's boundary from worker→panel to worker→admin extension (repointing the read-model rationale to `DES-ADMIN-VIA-PI-EXTENSION`) and added `settings-overlay-invalid` to its `reason` enum. Clarified in INT-SCHEDULES-FILE-CONTRACT that `provider`/`model`/`maxTurns` are pure passthrough — absent from an entry means absent from job data, resolved against the overlay/env at job start. De-numeralized the intro (contract count no longer stated). |
| 2026-07-22 | Token accounting (issue #25 / `REQ-TOKEN-ACCOUNTING-AND-CAPS`): INT-RUN-HISTORY-FILE-CONTRACT record gains an additive, nullable `tokens` `{ input, output, total, cost }` field (recovered from the exit line by `parseExitTokens`, read-only telemetry like `turns`); INT-RUNNER-EXIT-CODE-PROTOCOL gains the `token_budget` policy-`2` row and documents `tokens` on the exit line; INT-CONFIG-OVERLAY-CONTRACT gains the `maxTokens`/`dailyTokenCap` overlay keys and records that the daily token cap is the one knob enforced check-AFTER; INT-CONTAINER-RUNTIME-CONTRACT gains `PI_MAX_TOKENS` (forwarded only when set) and records that `PI_DAILY_TOKEN_CAP` is worker-only and never forwarded. |
| 2026-07-21 | Added INT-RUN-HISTORY-FILE-CONTRACT (worker→panel run-history read-model files). |
| 2026-07-17 | Added INT-SCHEDULES-FILE-CONTRACT, documenting the implemented `schedules.json` host-file shape (`PI_SCHEDULES_FILE`): `local`-only, `:`-free unique `id`, `task` as DATA, and load-time rejection of malformed/`github`/duplicate/missing-folder entries. |
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 §5.1, §5.3, §5.4, §5.5. `INT-SDK-SESSION-OPTIONS` is **new** — the source doc left the SDK option set unverified (its §10) and was wrong about the print-mode flag shape and the mode union. `PLAYWRIGHT_BROWSERS_PATH` added to the runtime contract: the source doc's Dockerfile was broken as written for non-root execution. The source doc's code sketches are deliberately **not** carried over — the real Dockerfile and handler are the truth, and a spec that mirrors them drifts on the first commit. |
| 2026-07-16 | **Correction — "pi never throws" was FALSE**, and it was in this file for a day as the justification for forbidding `try`/`catch` outright. Adversarial re-verification refuted it: `agent-session.ts:1242-1244` is `catch (error) { preflightResult?.(false); throw error; }`, and pi's **own JSDoc** (`:1099-1100`) documents throws on no-model, no-API-key, and missing `streamingBehavior`; `agent.ts:470-471` throws `"Agent is already processing."` outside the lifecycle try entirely. The rule as written would have produced a runner that dies of an unhandled rejection on a missing API key, exiting Node's default `1` = *retryable*, so the queue pays to retry a job that can never succeed. **Both mechanisms are required and cover disjoint sets: preflight throws, the loop swallows.** Also corrected: `StopReason` has **five** values (`packages/ai/src/types.ts:380`) — the entry handled three, and a default branch silently maps `"length"` (truncated output) to success. `reload()` has **no early return** — a second call fully re-runs everything; the earlier "the `loaded` guard makes a double call safe" framing was wrong. The lesson is the file's own: this entry was written from source and still asserted an absolute from a partial read. `INT-CONTAINER-RUNTIME-CONTRACT` gained `--init`, `--shm-size` (explicitly **not** `--ipc=host`, which Playwright recommends but which would share the host IPC namespace with an adversarial container), fonts (absent ⇒ tofu-box screenshots that silently gut `REQ-FRONTEND-VISUAL-VERIFY`), and the fact that **`COPY --chown` does not fix the EACCES trap** because it skips auto-created parent dirs. |
| 2026-07-15 | `INT-RUNNER-EXIT-CODE-PROTOCOL` gained its **mechanism**, which was the missing half. The codes were right; nothing said how to produce them, and **the obvious implementation produces them wrong**. ~~`pi never throws`~~ (**refuted the next day — see above**): `agent.ts:485-491` catches and `handleRunFailure` does not rethrow, so abort / 429 / 5xx / dead network all resolve `await session.prompt()` normally — and `prompt()` returns `Promise<void>`, so there is no return value either. A `try`/`catch` runner exits `0` on every infrastructure failure: queue records success, never retries, job did nothing — verbatim the worst failure class this project names. The exit code must be derived from `stopReason` on the terminal message, captured via `subscribe()`. Also recorded: the `subscribe()` listener is **sync and unawaited**, so a budget check that awaits will overshoot. `INT-CONTAINER-RUNTIME-CONTRACT` gained two runtime facts that fail *inside the container* where no Dockerfile hints at them: the agent dir must be **writable** by the non-root user (pi lazily writes `auth.json` on first credential touch), and Chromium needs **`--no-sandbox`** because `--cap-drop=ALL` denies it the seccomp/`SYS_ADMIN` its own sandbox requires — the container is the sandbox, and re-granting caps to Chromium would invert the security model. Two cited paths were **dead** (`packages/ai/src/api/env-api-keys.ts`, `packages/coding-agent/src/core/config.ts`); claims and line numbers were correct, only the addresses were wrong — the sneakiest defect class, since it reads as verified and cannot be followed. All cited paths now resolve. Good news recorded too: `before_agent_start` fires strictly before any provider HTTP call, so the assembled-prompt assertion costs **zero tokens**. |
| 2026-07-15 | `INT-SDK-SESSION-OPTIONS` **materially corrected** before any code was written against it. The contract block was **not callable as published**: it passed `appendSystemPromptOverride` as a `createAgentSession` option (it is a `DefaultResourceLoader` option) and called `getModel` as a free function (it is a `ModelRuntime` method, and is not exported). Two further traps were found by reading source and are now recorded: `noContextFiles` is **off by default**, so `CONST-NO-CONTEXT-FILES-MANDATORY` fails **open by omission**; and `createAgentSession` **does not `reload()` a loader you pass it**, so the persona is silently empty — a second, previously-unrecorded path to this project's most-feared failure, created by the *interaction* of two constitutional constraints. The irony is the point: this block's own `Why` called it *"the only contract here that fails invisibly"*, and it was itself wrong in three ways for a month. This is the third time a doc-verified pi claim has been refuted by source — exactly what the evidence convention in `constitution.md` predicts. |
| 2026-07-29 | Per-trigger job image (issue #41). **INT-TRIGGERS-FILE-CONTRACT**: an optional `run.image` on all four `run` shapes, with its own bullet mirroring `run.packages` — pure passthrough like `provider`/`model`/`maxTurns` (absent = `PI_JOB_IMAGE`, and resolved against **env only**, never the settings overlay), carried on all four kinds for `run.packages`' reason and not `run.github`'s (**a toolchain is a capability of the flow**, and a webhook trigger runs the same flows a cron trigger does), refused at load when not a non-empty string / when it carries whitespace / when it begins with `-`, its reference **grammar deliberately not validated** (docker's business; a regex would refuse malformed names while missing the far commoner well-formed-but-unbuilt one), and refused **pre-spend** when the tag is not on the host. The cron byte-match Acceptance admits `image` on the same terms as `github`/`packages` (absent stays absent, so an unflagged trigger's `data` is byte-identical), and the existing `PI_OFFLINE=1` env carve-out gains a **second dimension stated rather than discovered**: the env the worker *passes* is identical for every image, but the env *baked into* one is a fact about that image, so two triggers naming two images never had identical container environments. **INT-CONTAINER-RUNTIME-CONTRACT**: the real gap here — it **never named the image at all**, which was true-by-accident while there was one image this repo built. A new leading bullet makes it explicit that the contract is written against *an* image and is now the **conformance checklist** for any tag nameable in `run.image`, enumerating what the worker assumes and does not verify (non-root + writable `~/.pi/agent`, an entrypoint honouring `INT-RUNNER-EXIT-CODE-PROTOCOL`, the pinned pi version, the baked `PLAYWRIGHT_*` facts, root-owned agent-unwritable guardrails, fonts, and the **per-image** loader posture), with the note that **every one of them fails silently or late**. `--pull=never` added to the flag set with its own bullet: `docker run` defaults to `--pull=missing`, so an unknown name would be a **registry fetch** — the same make-it-unreachable move as `PI_OFFLINE=1`, one layer down. Acceptance extended to say the properties must hold for **every** nameable image, and that the assertions are ours for our tag and the operator's for theirs (`OQ-012`). **INT-SDK-SESSION-OPTIONS trap (g)** scoped: its `image/runner/package.json` claims describe an image built from **this repo's Dockerfile**; a foreign image's layout is simply not described — which costs nothing, because the trap's invariant is layout-independent by design (runtime mutation probe, `tryResolve` on both candidates). The *assertion* is what loses coverage, not the code. **INT-RUN-HISTORY-FILE-CONTRACT**: one enum token, `job-image-missing` — a policy outcome, not `container-never-started`, since the container was never attempted. |
| 2026-07-29 | Issue #42 (GitLab triggers). Added **INT-GITLAB-PAYLOAD-SUBSET**, a SIBLING of `INT-WEBHOOK-PAYLOAD-SUBSET` rather than an extension of it — IDs are permanent addresses, and a GitLab payload is a different shape, not more of GitHub's. It names three fields with no GitHub counterpart and says why each exists: **`changes.labels`, where the DIFF is the trigger** (GitLab has no `labeled` action, so a label add arrives as `update` with a before/after pair — matching the CURRENT set, which is what the GitHub path does because there a `labeled` action already means "a label just moved", would re-fire on every later retitle, reassign or milestone change of an already-labelled issue, each one a paid run); **`noteable_type`**, which states issue-vs-merge-request where GitHub infers it from `issue.pull_request`, and getting it wrong mints a `pi/issue-<n>` branch for something that is already an MR — wrong work, no error, reads as success; and **`user.username`**, carried where GitHub's `sender.login` is deliberately dropped, because GitLab puts no access level in the payload and the member lookup needs an identity — personal data with exactly one consumer, which never reaches a log line, the job, or the run record. Also records `iid`-never-`id` and that the project rides as its numeric id, because a `group/subgroup/project` path does not merely break the `owner/name` split — it **passes** it, both halves non-empty, and the project silently becomes its own parent group. **INT-TRIGGERS-FILE-CONTRACT**: the diagonal becomes a **matrix** — the sentence "every webhook type ⟹ `run.kind:"github"`" was flatly false and is replaced — plus three new bullets: `run.kind` selects the forge while `on.type` stays shared (a label is a label anywhere); the **action vocabulary is per forge**, validated against the one the entry names, because a word from the wrong forge is not malformed and breaks nothing — it never matches an event, so the trigger loads clean and is silently dead, and refusing at load is what turns that into a message; and the positive-selector rule differs for a reason rather than by accident (a `labeled` github rule has only its predicate as the approval gate, while every gitlab trigger is additionally access-gated). The one-comment-trigger cap becomes **per forge**: it exists because the receiver holds one comment rule per forge and a second would be unreachable, so it caps ambiguity, not count. **INT-CONTAINER-RUNTIME-CONTRACT**: the minted token now goes under **its own forge's variable names and only those** (`GITHUB_TOKEN`/`GH_TOKEN`, or `GITLAB_TOKEN`/`GL_TOKEN`/`GITLAB_HOST`) — cross-forge export is refused by construction, because a GitLab credential exported as `GITHUB_TOKEN` is sent by `gh` to github.com on the agent's first invocation, which is exactly how a scoped token stops being scoped — and the `PI_FORWARD_ENV` refusal grows from a pair to a set of every minted name. **INT-RUN-HISTORY-FILE-CONTRACT**: `kind` gains `gitlab`, and the `target` grammar gains `<project>!<iid>`, GitLab's own notation, because issues and merge requests are separate per-project sequences and `repo#5` would name two different objects. **INT-CONTAINER-JOB-INPUTS** and **INT-OUTBOX-CONTRACT** are UNCHANGED and were checked: `/outbox` stays local-only, a gitlab job is driven by adversarial issue text exactly as a github one is, and it inherits `OQ-009` verbatim rather than opening a new question. |
| 2026-07-31 | Issue #48. **NEW `INT-SESSION-STORE-CONTRACT`**: the second agent-authored channel the host reads back, described in `INT-OUTBOX-CONTRACT`'s shape. Canonical store never mounted, per-job copy, completed-only promotion, and both validation orders in full. Three clauses carry their own reasoning rather than a rule: **`lstat`, regular files only** is security not hygiene — the agent owns `/session`, so a symlink it plants resolves on the HOST, and the repo's own habit is wrong here since `makeLogReaper` uses `statSync`; the **0-byte staging** is what makes pi's `openSync(path,"wx")` EEXIST race unreachable rather than merely unlikely; and the **pi-version gate** exists because a transcript outlives the pi that wrote it and the repair hook is an extension-author API this project cannot reach. `INT-CONTAINER-RUNTIME-CONTRACT` **AMENDED ×3**: `/session:rw` joins the mount list (per-job, conditional), `PI_SESSION_FILE` joins the env list under the `PI_PACKAGES` omitted-when-absent rule, and the conformance checklist gains the pi-version LABEL — which belongs on that list precisely because both its failure modes are quiet. `INT-CONTAINER-JOB-INPUTS` **AMENDED**: says why `/session` is deliberately NOT a `/job` input — `/job` is the read-only agent-untamperable channel and `/session` is agent-written by design, so putting it there would have required making part of `/job` writable, which is the property `/job` exists to have. `INT-TRIGGERS-FILE-CONTRACT` **AMENDED ×2**: `run.resume` in the grammar and its own bullet, including why its polarity is the OPPOSITE of `run.packages` (staging is an act already performed; persisting is a disclosure) and why the damaging misreading runs the other way — a truthy `"false"` string reads as an opt-out and would arm it. `INT-RUN-HISTORY-FILE-CONTRACT` **AMENDED**: the additive nullable `session` object, and the explicit statement that the key and branch name are ABSENT BY DESIGN, since this record's PII-free-by-construction property rests on holding no attacker-chosen string. `INT-SDK-SESSION-OPTIONS` **AMENDED**: its *"`SessionManager.inMemory()` because the container is ephemeral"* sentence becomes conditional, and it gains the traps found by reading pi's own docs — `open` throws on a non-empty unparseable file, `model` must stay explicit or a transcript picks it, `thinkingLevel` is NOT passed and therefore IS restored from the transcript, and `PI_CODING_AGENT_SESSION_DIR` is documented by pi and read by nothing in `dist/`. `INT-WEBHOOK-PAYLOAD-SUBSET` **UNCHANGED, and the check matters**: the head ref is resolved from the forge API, never the payload, so its *"no `head.sha`/`head.ref` value is ever passed to a clone or fetch"* clause extends to session keys with nothing to weaken. `INT-OUTBOX-CONTRACT` **UNCHANGED, checked**: `/outbox` stays local-only; `/session` is a different channel with a different contract. |
| 2026-07-31 | Issues #43 + #61. Added **INT-FORGEJO-PAYLOAD-SUBSET** and **INT-AZURE-PAYLOAD-SUBSET**, both SIBLINGS of `INT-WEBHOOK-PAYLOAD-SUBSET` rather than extensions of it -- IDs are permanent addresses, and a forge's payload is a different shape rather than more of GitHub's. Forgejo's is the closest of the four to GitHub's, which is exactly why it is separate: "almost the same" is the shape that breaks quietly, and it breaks in three places -- `label_updated`/`synchronized` are Forgejo's own action words (read against GitHub's vocabulary they fall out as `unhandled-event`: HTTP 200, no job, no error, nothing that says why), `is_pull` is TOP-LEVEL where GitHub carries `issue.pull_request` (reading the wrong one mints `pi/issue-<n>` for something already a pull request), and `sender.login` must be carried because the permission lookup takes a username. `label_cleared` maps to **nothing, permanently**. Azure's shares least: no delivery-id header (the key is the body's `id`; `notificationId` is a per-subscription integer sequence and would collide on delivery 1), **two actor representations inside one forge** (GUID on a pull request, a `Display Name <email>` string on a work item), tags as a semicolon STRING arriving as a DIFF on update -- `INT-GITLAB-PAYLOAD-SUBSET`'s `changes.labels` trap reached from a different direction, and matching the current SET would bill a run per typo fix forever -- and a scope TRIPLE of which a work item names only two, since a work item belongs to a project and a project may hold many repositories. `message`/`detailedMessage` are excluded deliberately: pre-rendered prose carrying the title, the kind of field that looks convenient and drags untrusted text somewhere it was never classified for. `INT-WEBHOOK-PAYLOAD-SUBSET` **amended in its sub-title only** and stays GitHub-only, exactly as it did for GitLab. `INT-TRIGGERS-FILE-CONTRACT` **amended**: `run.kind` gains `forgejo` and `azure`, two more per-forge action vocabularies, and a genuinely new field -- **`run.repository`**, required on an azure `label`/`comment` trigger and REFUSED on every other forge's, because an Azure work item names no repository and accepted-and-ignored is how an operator comes to trust a field that does nothing. An azure `pull_request` rule may not carry a label predicate at all: Azure attaches tags to work items and never to pull requests, so `any`/`all`/`none` could never match and a rule that loads clean and can never fire reads as a broken harness. `INT-CONTAINER-RUNTIME-CONTRACT` **amended**: per-forge token variable names for two more forges, and the new **`dev.pi-dispatch.forges`** image label joins the conformance checklist -- it belongs in the "fails silently or late" list the entry already keeps, and `verify-image.sh` checks the declared list against the CLIs actually installed so the label cannot lie. `INT-RUN-HISTORY-FILE-CONTRACT` **amended**: `kind` gains `forgejo` and `azure`, the `target` grammar gains their notations -- **and the documented-but-unimplemented `gitlab` case is finally implemented**, closing a gap open since #42. `INT-CONTAINER-JOB-INPUTS`, `INT-OUTBOX-CONTRACT`, `INT-SDK-SESSION-OPTIONS`, `INT-SESSION-STORE-CONTRACT` **UNCHANGED, checked**: the container contract is forge-blind, and a fourth forge changes no byte of what a job container is handed. |
