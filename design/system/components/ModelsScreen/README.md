Models maps each role to a model once, lists the fallbacks used on a rate limit, shows what is cooling down, and proposes new models with a canary, never adopting them by itself.

**How a person uses it.**
- **Radius banner.** The page opens with an attention banner when a Radius gateway is configured: Radius bills, so there is no local cap.
- **Model roles.** A table of planner, editor, explorer, reviewer and tidier, with each role's model, its fallbacks in order and the flows that use it. Editing a row opens the form, a diff of the settings file and a safe confirm bar with an undo line.
- **Cooling down.** Which model is rate limited and until when, as a ring of the time left. It also says where each role's next attempt goes and which jobs wait because their role has no fallback. A run that fell back says so: "gh-c41f ran on fallback kimi-for-coding because the primary was rate limited".
- **New model available.** A proposal with a canary run beside the current model, comparing cost per run, completed runs, turns and tokens. Adopt is a paid act and is confirmed first. Dismiss and more canary runs are always offered.
- **Models in use.** Each model's provider, whether it has a price, which dollar windows count it, and its state.

**Panels.** `p-roles`, `p-proposals`, `p-cooldowns`, `p-models`.

**The server provides.**
- The role map and the fallback lists from settings.
- Cooldowns with their reason and end time.
- Canary results.
- Price status per model, and whether a gateway bills outside the local caps.

**Why it works this way.**
- Models change only by a reviewed edit: the role map is written to the settings file through a preview and a confirm, never by a job or a model.
- A proposal is never adopted until a person confirms it, and adopting starts no run by itself.
- A run that fell back says so on its own run page too, so a cheaper or slower result is never a surprise.
- A model without a price is skipped as a fallback, so a fallback can never spend outside the dollar windows unseen.

**Fixture note.** This is a planned screen (#716, #717, #693). All of it is sample, except the model names (claude-sonnet-5-5, kimi-for-coding, claude-haiku-5-5) and the $80.00 weekly window for claude-sonnet-5-5.
