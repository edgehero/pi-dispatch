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
    // Repo path FIRST so a repo skill overrides a global one of the same name (pi is first-path-wins).
    additionalSkillPaths:     ["/job/pi/skills", ...(existsSync("/opt/pi-global/skills") ? ["/opt/pi-global/skills"] : [])],
    // Overlay extensions load unless the operator opted OUT (PI_GLOBAL_ALLOW_EXTENSIONS=0) AND the dir
    // is present. Operator-staged pi packages (REQ-GLOBAL-PI-OVERLAY) ride this same option, LAST —
    // extension resolution is first-path-wins, so nothing a package ships can shadow a repo or overlay
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

  **(i) Skill precedence is decided by `skillsOverride`, not by path order.** `additionalSkillPaths` sets
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

**container → worker.**

- **Contract**:
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
  originals only.
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
  /job/prompt.md          task text (issue/PR payload, or the operator-supplied task)
  /job/event.json         structured trigger context — written for EVERY job, github and local alike
                          (both shapes below)
  /job/pi/APPEND_SYSTEM.md      project persona   ─┐ materialised by the worker from the
  /job/pi/skills/<name>/SKILL.md project skills    ┘  project's .pi/ at the DEFAULT-BRANCH SHA,
                                                     via `git show`, never `fs.readFile`
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
- **`/job/pi/extensions` is NOT written, and the seam is deliberate.** An earlier revision of this list
  carried it; the worker's materialiser only ever emits `pi/APPEND_SYSTEM.md` and
  `pi/skills/<name>/SKILL.md`, so the path documented a file that never existed. Repo extensions stay
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
    discriminator (`INT-WEBHOOK-PAYLOAD-SUBSET`) — plus three additions. `comment: { body,
    author_association }`, comment-triggered jobs only: the invoking comment, carried on the job's
    `trigger`; the body is untrusted user-authored data permitted in `/job` and the prompt's fenced data
    region **only** — never in worker logs or the run record (`no-pii-in-logs`,
    `CONST-ISSUE-TEXT-IS-DATA`). `sender: { id }` — **no `login`**: the subset never extracted it, so the
    key was written but never populated, and it is now not written at all. And `matched: { index, type,
    label | phrase | action }` — **HARNESS-COMPUTED** metadata, the filter's own decision record and not a
    webhook payload field: `index` is the 0-based position of the winning entry in the raw `triggers.json`
    `triggers` array (cron entries counted — the file index is the rule's identity), `type` is that
    entry's `on.type`, and the third key names what satisfied the rule — for `label` the label that hit
    (first `any` hit, else `all[0]`), for `comment` the configured `phrase`, for `pull_request` the
    `action`. `matched` does **not** enter the prompt.
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
  `.pi/APPEND_SYSTEM.md` or `.pi/skills/x/SKILL.md` in the serviced repo results in **no host file
  content anywhere** in `/job` or the assembled prompt.

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
    --pids-limit=512 --shm-size=1g`
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
  - Env **passed by the worker**: the configured provider's key variable(s), derived — not hardcoded
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
    `path.delimiter` is `";"` on Windows and would be wrong); and each name in `PI_FORWARD_ENV` (an explicit operator
    allowlist of extra host vars — e.g. a custom provider's key — forwarded by exact `-e NAME=VALUE`, never a
    pass-through, so it satisfies `no-broad-env-into-container`; **every** minted-token name — `GITHUB_TOKEN`,
    `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN` — is refused in the allowlist at config load, because a
    forwarded operator token would silently override the minted per-job value. The list grows with each
    forge, which is why it is a set rather than a pair). Note `PI_DAILY_TOKEN_CAP` is **worker-only and is
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
  - **Env is exactly `TERM` and `TMOUT`.** No minted forge token under any forge's variable names, no
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
  sweep whose docker lookup failed removes nothing.

## INT-WEBHOOK-PAYLOAD-SUBSET

**GitHub → receiver.** *(GitLab's is a separate contract — `INT-GITLAB-PAYLOAD-SUBSET`. This ID keeps
its name and its GitHub-only body: IDs are permanent addresses, and a second forge's payload is a
different shape rather than an extension of this one.)*

- **Contract**:
  - Events consumed: `issues`, `issue_comment`, `pull_request`. Everything else drops as `unhandled-event`.
  - Headers consumed: `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`
  - Body fields consumed: `action`, `issue.number`, `issue.title`, `issue.body`, `issue.labels[].name`,
    `issue.pull_request` (presence marker only — an `issue_comment` on a PR carries it), `comment.body`,
    `comment.author_association`, `sender.id`, `repository.full_name`, and for a `pull_request` event:
    `pull_request.number`, `pull_request.title`, `pull_request.body`, `pull_request.author_association`,
    `pull_request.labels[].name`, `pull_request.head.ref`, `pull_request.head.sha`,
    `pull_request.head.repo.full_name`, `pull_request.base.ref`
  - `issue.labels[].name` and `pull_request.labels[].name` are consumed as a **set**, evaluated by the
    `{any, all, none}` trigger predicate (`REQ-TRIGGER-AUTHOR-GATE`) — this changes *how* the field is
    used, not which fields are read.
  - For a comment-triggered job, `comment.body` and `comment.author_association` now ride the job as
    `trigger.comment` into `/job/event.json` and the prompt's fenced data region
    (`INT-CONTAINER-JOB-INPUTS`) — the first time these two fields leave the receiver. The subset itself is
    unchanged — both were already named here — and the body stays data-by-placement
    (`CONST-ISSUE-TEXT-IS-DATA`).
  - **`pull_request.head.*` and `.base.*` are DATA only.** They are attacker-controlled (the head may be a
    fork) and are carried into `/job/event.json` for the flow's own `gh` use; they are **never** used as a
    clone ref. The worker still clones the base repo's default-branch SHA (`INT-CONTAINER-JOB-INPUTS`).
  - **Everything else is ignored.**
- **Why**: Naming the subset **is** the contract. Because everything else is ignored by construction, an
  upstream schema addition cannot change our behaviour — and a reviewer can see the entire attack
  surface as one list, instead of inferring it from destructuring scattered across a handler. Every
  field here is attacker-controlled except the headers and `sender.id`, and the headers are only
  trustworthy *after* `CONST-HMAC-OVER-RAW-BODY` has run. `pull_request.author_association` is
  attacker-*claimed* but GitHub-*computed*, and it gates only auto actions — a stranger cannot forge
  themselves into `COLLABORATOR` because GitHub, not the payload author, sets it.
- **Traces to**: `CONST-HMAC-OVER-RAW-BODY`, `REQ-TRIGGER-AUTHOR-GATE`, `REQ-DEDUP-BY-DELIVERY-GUID`,
  `INT-CONTAINER-JOB-INPUTS`
- **Acceptance**: Given a payload with unknown extra fields, behaviour is unchanged. Given a
  `pull_request` payload, no `head.sha`/`head.ref` value is ever passed to a clone or fetch — the fetch
  pins the base default-branch SHA.

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
- **Three fields have no GitHub counterpart**, and they are why this is a separate projection:
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
and selects the `on.type` it owns (worker: `cron`; receiver: `label`, `comment`, `pull_request`).

- **Contract**:
  ```
  triggers.json  (path via PI_TRIGGERS_FILE; absolute; unset = cron disabled for the worker, but the
                  receiver requires it)
  { "triggers": [
    { "on": { "type": "cron", "id": "<[A-Za-z0-9._-]+, no ':' , unique>",
              "pattern": "<5 or 6 space-separated fields>" },
      "run": { "kind": "local", "folder": "<absolute HOST path, must exist>", "flow": "<flow name>",
               "task": "<operator-authored prompt text — DATA, lands in /job/prompt.md>",
               "provider": "<optional passthrough>", "model": "<optional>", "maxTurns": <optional>,
               "github": <optional boolean>, "packages": <optional boolean>,
               "resume": <optional boolean>,
               "image": "<optional: docker image ref; absent = PI_JOB_IMAGE>" } },
    { "on": { "type": "label", "any": [...], "all": [...], "none": [...] },
      "run": { "kind": "github", "flow": "<flow name>", "packages": <optional boolean>,
               "image": "<optional>", "replicas": <optional int 2..3; github only> } },
    { "on": { "type": "comment", "phrase": "<trigger phrase>" },       // at most one
      "run": { "kind": "github", "flow": "<default flow>", "packages": <optional boolean>,
               "image": "<optional>", "replicas": <optional int 2..3; github only> } },
    { "on": { "type": "pull_request", "action": ["labeled"|"opened"|"synchronize"|"reopened", ...],
              "any": [...], "all": [...], "none": [...] },
      "run": { "kind": "github", "flow": "<flow name>", "packages": <optional boolean>,
               "image": "<optional>", "replicas": <optional int 2..3; github only> } } ] }
  ```
- **The on × run MATRIX is the trust boundary, enforced fail-loud at load**: `cron ⟹ run.kind:"local"`;
  every webhook type (`label`, `comment`, `pull_request`) `⟹ run.kind ∈ {"github", "gitlab"}` — a forge
  job, never a local one. Off-matrix throws a `piDispatchConfig` error — a `cron` trigger has no webhook
  delivery, issue/PR number, title, or body to supply a forge run, and a webhook trigger is adversarial
  input that always produces a forge job.
- **`run.kind` selects the forge; `on.type` is shared.** A label is a label and a comment is a comment on
  any forge, so the trigger types and their `{any, all, none}` predicates are identical. The **action**
  vocabulary is not, and is validated against the vocabulary of whichever forge the entry names:
  `github` takes `labeled|opened|synchronize|reopened`, `gitlab` takes `open|update|reopen|approved` — each
  in that forge's own words, so an operator can grep their own documentation for them. GitLab has no
  `labeled` (a label added to a merge request arrives as `update` with a `changes.labels` diff), no
  `synchronize` (an `update` carrying `oldrev` is the analogue), and `approved` has no GitHub counterpart
  at all; `merge` and `close` are omitted because a job started by either has nothing left to act on.
  **The refusal matters more than it looks**: an action word from the wrong forge is not malformed and
  breaks nothing downstream — it simply never matches an event, so the trigger loads clean and is
  silently dead. Refusing at load is what turns that into a message.
- **A `labeled` github `pull_request` rule must carry a positive selector; a gitlab one need not.** Not an
  inconsistency: on GitHub the predicate IS the approval gate for that action, so a rule without one is
  ungated. Every gitlab trigger is additionally gated on the actor's resolved access level
  (`CONST-TRIGGER-AUTHOR-GATE`), so there is no ungated case for a predicate to have to close. A **label**
  trigger still requires a positive selector on both forges, because a `none`-only rule fires on any
  labelling event at all.
- **At most one `comment` trigger PER FORGE.** The receiver holds one comment rule per forge and a second
  would be silently unreachable, so the cap is on ambiguity rather than on count — and a deployment
  serving both forges is entitled to answer `@pi` on each.
- **`run.github` (cron only, optional boolean)**: absent or `false` = no token — the zero-GitHub default;
  `true` = the worker mints the same per-job token the GitHub path mints and injects it as
  `GITHUB_TOKEN`/`GH_TOKEN` (`INT-CONTAINER-RUNTIME-CONTRACT`), so the flow can use the `gh` CLI. A
  non-boolean value is refused at load; with `GITHUB_AUTH_SOURCE=app` a `run.github` job refuses at mint
  time — an installation token is per-repo, and a local job has no repo to scope it to.
- **`run.resume` (ALL FOUR trigger kinds, optional boolean) — an opt-IN, and the polarity is deliberate.**
  Absent or `false` = today's behaviour: no transcript on disk, no `/session` mount, byte-identical argv.
  `true` = this trigger's jobs continue the session the previous job for the same key produced
  (`REQ-RESUMABLE-SESSION`, `INT-SESSION-STORE-CONTRACT`). The polarity is the **opposite** of
  `run.packages` below, and the two flags gate different kinds of thing: staging a pi package is an
  operator act already performed, so the set they staged is the set their jobs get and a trigger opts
  *out*; persisting a transcript is a **disclosure** — the agent's full working history, tool output, file
  contents and its own reasoning, written to host disk and replayed into a later job — and disclosures
  default off. Non-boolean is refused at load, and here the damaging misreading runs the other way from
  `run.packages`': a truthy `"false"` string reads to an operator as an opt-out and would arm the
  disclosure instead. Carried on all four kinds rather than cron-only like `run.github`, for `run.image`'s
  reason: continuing a conversation is a property of the FLOW. A cron job keys on its own scheduler id,
  which is the one key in this feature chosen by nobody untrusted.
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
- **`run.replicas` (github `label`/`comment`/`pull_request` only, optional integer `2..3`) — a fanout
  count, and the only field in this file that MULTIPLIES SPEND** (`REQ-REPLICA-RUNS`). Absent = today: one
  delivery, one job, one branch, one pull request, and `data` byte-identical to the pre-feature shape.
  Present = the receiver enqueues exactly that many independent jobs from the one delivery, each carrying
  its own 1-based `replica` index. Every layer that would otherwise collapse them back to one is given the
  index: the jobId (`gh-<guid>-r<i>`), the semantic dedup key (`repo#n:flow:r<i>`), the minted branch
  (`pi/issue-<n>-r<i>`), the PR title marker, and the run record.
  **Four refusals, each for its own reason, all fail-loud at load in both services.** A **`kind: "local"`
  (cron) trigger** is refused because a local job's `/workspace` *is* the operator's folder, bind-mounted
  read-write and edited in place — two replicas would edit one working tree with no gate and no undo,
  where a forge job gets its own `mkdtemp`'d clone. A **non-`github` forge** is refused as *not yet
  covered* rather than impossible: every forge mints its branch through the same `issueBranch`, so this is
  a gap to close. A value outside `2..3` or not an integer is refused, and `1` is refused **rather than
  accepted-and-ignored** — a one-member replica set is a field that does nothing, and a field that does
  nothing is one an operator sets and then trusts. `3` is the ceiling because `PI_CONCURRENCY` defaults to
  3, so a fourth replica would queue rather than race, promising a comparison the deployment cannot
  deliver. Finally, **`run.replicas` beside `run.resume: true`** is refused, naming both fields: a resumed
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
  Given `run.replicas` on a `cron` trigger, on a `gitlab`/`forgejo`/`azure` trigger, beside
  `run.resume: true`, or with a value that is not an integer in `2..3` (including `1` and `4`), when the
  config loads, then **both services throw** and the message names the field and the reason. Given
  `run.replicas: 2` on a github label trigger and one matching delivery, when the receiver accepts it, then
  **two** jobs are enqueued with jobIds `gh-<guid>-r1`/`-r2` and dedup ids `repo#n:flow:r1`/`:r2`, and a
  redelivery of that same GUID enqueues **nothing further**. Given a failure enqueueing replica *k*, then
  the receiver answers **503** with replicas `1..k-1` already queued — the retry converges on exactly *n*
  jobs, never more, because the queued ones dedup on their own now-taken ids.

## INT-PI-PACKAGES-FILE-CONTRACT

**operator → stager → worker + runner.** The operator declares which third-party pi packages exist; the
host-side stager materialises them into the global overlay and writes a receipt; the worker and `doctor`
read that receipt. Three consumers, one declaration, and the file the operator edits is never the file the
worker reads.

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
    <PI_GLOBAL_PI_DIR>/packages/<dir>/node_modules/**     its OWN deps — no install, no network at job time
    <PI_GLOBAL_PI_DIR>/packages/packages.json             the stage manifest (the receipt)
    { "stagedAt": "<ISO-8601>", "packages": [ { "name", "version", "dir" } ] }
    ```
    `packages.json` is **the read model** for everything downstream: the worker turns it into container
    paths `/opt/pi-global/packages/<dir>` (built with template literals, never `path.join` — the worker may
    run on Windows and these are Linux container paths), and `doctor` and the admin panel read it to show
    what is staged. Reading it **NEVER throws**: it runs on the job path, where a corrupt or half-written
    manifest must degrade to "no staged packages" rather than crash the worker mid-queue, and its entries
    are **re-validated on the way in** because the file is a host artifact an operator may have hand-edited
    between stage time and job time.
- **Why**: Two directions, two error policies, and the split is the whole point. `pi-packages.json` is the
  **operator's** declaration, read once, on the host, by an interactive command — so it fails **loud** and
  names the offending package. `packages.json` is the **stager's receipt**, read on the money path by a
  long-running worker — so it fails **quiet** and degrades to nothing staged. Inverting either would be
  wrong in the expensive direction: a loud job-path read turns one bad byte into a stalled queue, and a
  quiet stage-time read silently ships an unpinned or admin-shaped package into every job container.
  Staging on the **host** rather than resolving `npm:` in-container is what lets a job load third-party
  extensions with egress denied and `PI_OFFLINE=1` set (`INT-CONTAINER-RUNTIME-CONTRACT`): pi treats any
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
    "reason":    "<fixed enum: worker-abort|over-budget|unprotected-branch|runner-policy|container-never-started|settings-overlay-invalid|job-image-missing|job-image-replicas-unsupported|...>" | null,
    "exitCode":  <int> | null,
    "turns":     <int> | null,
    "tokens":    { "input": <int>, "output": <int>, "total": <int>, "cost": <number>,          // per-job usage totals; null when the container died before the exit line
                   "metered": <bool>,                                                          // true = process-wide meter; false = the subscribe() fallback (then the keys below are absent)
                   "rootTotal": <int>, "otherTotal": <int>, "looseTotal": <int>,                // attribution split; sums to `total`
                   "sessions": <int>, "calls": <int>, "unresolved": <int>, "unpriced": <int> } | null,
    "budgetReserved": <bool> | null,
    "attempt":   <int>,
    "parentJobId": "<job id: same id-space as jobId>" | null,
    "chainDepth":  <int> | null,
    "chainRefused": <int> | null,   // count of chain requests refused on this parent; 0 = none
    "replica":  <int> | null,       // this job's 1-based index within its replica set; null = an ordinary run
    "replicas": <int> | null,       // the set size, so `r2` is legible without finding the sibling row
    "session": { "resumed": <bool>,                                                             // what pi ACTUALLY did
                 "reason": "<fixed enum: resumed|absent|expired|too-large|unparseable|not-a-regular-file|pi-version-changed|locked|disabled>" | null,
                 "bytes": <int> | null } | null }   // null when the job had no session at all
  ```
  Field order is the serialisation order (`JSON.stringify` emits insertion order). The filename uses the
  **sanitized** id (`:` → `_`, because `repeat:<sched>:<millis>` is NTFS-illegal); the record **body**
  keeps the raw `jobId`. `reason` is a fixed enum passed through from the terminal outcome — never
  free-form and never payload text — and `turns` is `null` when the container died before emitting the
  runner `exit` line.
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
  read as an accidental double-run rather than as the pair an operator asked for. The `tokens` field is **additive and nullable**
  in exactly the same way — an explicit no-spread literal of the runner's per-job usage totals
  (`REQ-TOKEN-ACCOUNTING-AND-CAPS`), or `null` when the container died before emitting the runner `exit`
  line. It is PII-free by construction: integer token counts and a numeric cost only, no
  payload text. It is read-only telemetry recovered from the exit line (`parseExitTokens`) exactly as
  `turns` is, and like `turns` it never feeds exit-code or retry classification (`INT-RUNNER-EXIT-CODE-PROTOCOL`).
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
  `PI_CAPTURE_JOB_LOGS` is set.

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
  is **same-folder-only**; unknown keys are ignored. `task` is agent-authored **DATA**
  (`CONST-ISSUE-TEXT-IS-DATA`, one layer down): it becomes the child's `/job/prompt.md` user prompt and
  **never** enters the run-history `.json` record.
- **Validation order** (host-side, fail-closed at the first miss): count cap (`PI_CHAIN_MAX_PER_JOB`) →
  per-file size cap (4 KiB) → regular-file-only (a symlink, directory, or device is rejected) → JSON
  parse → flow-name charset (the skill charset) → depth cap (host-computed `parent.chainDepth + 1` against
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
  `CONST-BUDGET-BEFORE-TOKENS`, `INT-RUN-HISTORY-FILE-CONTRACT`
- **Acceptance**: Given a completed local parent with a valid `request-1.json`, when the worker collects
  `/outbox`, then exactly one child is enqueued on the parent's own folder with `chainDepth = parent + 1`;
  given a request over the count or depth cap, or whose flow fails the `ai-trigger` gate, when collected,
  then it is refused and no child is enqueued; given a **github** parent, when it exits, then no `/outbox`
  exists to collect; given a symlink or an oversize `request-<n>.json`, when validated, then it is
  rejected; given a **retried** parent, when its outbox is re-collected, then the idempotent child id
  dedups and no second child is enqueued.

## INT-SESSION-STORE-CONTRACT

**worker <-> host store <-> container.**

- **Contract**:
  ```
  <PI_SESSIONS_DIR>/<key>/current.jsonl   canonical transcript; mode 0700; NEVER bind-mounted
  <PI_SESSIONS_DIR>/<key>/pi-version      the pi version that wrote it
  <PI_SESSIONS_DIR>/<key>/lock            exclusive-create promotion lock; absent when free
  <jobDir>/session/current.jsonl          this job's OWN copy; mounted /session:rw
  PI_SESSION_FILE=/session/current.jsonl  emitted ONLY when the job has a transcript; never empty
  ```
  `key` is `sha256(kind \0 repo \0 ref)` truncated — a hash, not a path built from a branch.
  `PI_SESSIONS_DIR` has **no default**; unset means the feature is unavailable.
- **Read path**, host-side, fail-open at the first miss, every miss a named cold start: key resolves ->
  canonical file exists -> **`lstat` says regular file, not a symlink** -> size <= `PI_SESSION_MAX_BYTES`
  -> mtime within `PI_SESSIONS_TTL_DAYS` -> stamped `pi-version` matches the job image's label -> first
  parsed line is a `{"type":"session"}` header -> copy into the per-job dir. A cold start stages a
  **0-byte file** rather than nothing.
- **Write path**, after a `completed` exit **only**: the same `lstat` and size checks on the container's
  output, then an atomic rename under the per-key lock. A job that cannot take the lock discards rather
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

## Revision History

| Date | Change |
|---|---|
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
