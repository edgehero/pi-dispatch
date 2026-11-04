The preview and Confirm of a change to what a trigger's jobs get, what the card refuses and why, and what a viewer sees.

**What waits.** Per-extension switches, a chip per extension tool, and the two fields behind them (`run.excludeExtensions`, `run.excludeExtensionTools`) wait on a later pull request, which holds until a release that reads a file's version is on every host. The older-host refusal and the `exclude-tool-not-loaded` refusal wait with them.

**How a person uses it.**
- **Preview** shows the triggers file's row as it would be written, then the Confirm:
  - each change in words, never an arrow, a widening said as one (*connect to mcp.example.com, with LINEAR_API_KEY by name*);
  - when it takes effect, each only as far as is true of this file on this host: the services reading this file use it from their next reload, for the jobs they queue after that; a job in line keeps what it was queued with, or is refused if this file now narrows something it lacks; a host with its own copy keeps what it has until that copy changes. On a schedule: *While hosts' copies differ on a schedule, no host installs a change to one, so this one moves when they agree.*
  - the jobs it affects: *With this change, a host reading this file refuses 1 of this trigger's jobs in line, before it spends: gh-c9e1 as trigger-skew (run.mcp)*;
  - what a host without the server does: refuses the job as `mcp-server-unknown`, before it spends. A host with no overlay, or no `mcp.json`, refuses it as `mcp-config-invalid`;
  - where it is written and how it is audited (`trigger-edit`, by the person): *on this host*, because that file is all this page writes.
  - **Undo** puts back the keys the change touched, as they were, or says what to edit by hand where this page could not write them.
- **What it refuses, and why:** a server some hosts lack (said on the switch, before the preview), a model that cannot make one call under the cap, a cap above the deployment's, a trigger that changed since the page drew it, a server this host's pickup check would refuse (its key not passed as `mcp-secret-unmapped`, every way in removed as `mcp-excluded`), and what belongs elsewhere. A cap that clears the floor and not a short task's first call previews, and says so.
- **As a viewer sees it:** the same six rows as the operator's, read only.

**Panels.** `p-trigger-gets-preview`, `p-trigger-gets-refuses`, `p-trigger-gets-viewer`.

**The server provides.** The trigger edit's body and Confirm, widened to the card's fields for a person only. A digest of the trigger's entry as the page read it is sent back and compared at preview, because the Confirm's own snapshot covers only preview to Confirm, and that is what refuses a stale page. Of the entry and not the file, so an edit of another trigger sends nobody back. The versions each live host publishes (#761, `INT-HOST-REGISTRY-CONTRACT`), read only when the file would need more than version 1. Each model's first-call bound.

**Who sees what.** Operators preview and confirm. Viewers see the rows. Tools and agents cannot reach this action.

**Why it works this way.**
- **The boundary stays where it is.** `TOOL_PROOF_FIELDS` exist because which systems a job reaches and what it spends is the operator's to write. A person at the console is the operator; a model's call is not.
- **Refuse what would fail later, now.** A first call above the cap refuses later, inside the container (`image/runner/src/usage-meter.mjs`), so the preview says so first. The preview runs the worker's own pickup check on the proposed entry, with what this host holds (`makeMcpCheck`), because a sentence that says jobs connect while the next one is refused is the worst a Confirm can say. A server missing on another host refuses at pickup there, for free, and the preview says which hosts have it.
- **The cap's refusal says who can move it.** A trigger's `run.maxCostUsd` only lowers the deployment's cap, so the sentence names the deployment's settings as the place, and offers no way to do it here. It says *needs at least*, because the bound is a lower one.
- **The plain ring on a widening.** The console's Confirm is plain, paid or destructive (`previewBarHtml`), and it has no ring for a widening: a setting on a cap is plain today, and deleting a limit is destructive for having no way back. This change has its Undo, so the widening is said in words, with an attention glyph on its line.

**Fixture note.** Trigger 3, gh-c9e1 (its one job in line, as on TriggerDetail), the hosts and the cap are the fixture. $2.654295 is `firstCallBoundMicros` at `FIRST_CALL_SHORT_TASK_BYTES` for anthropic / claude-opus-5-5 at the pinned pi 1.5.0, the amount a refusal offers. $2.62144 is `firstCallFloorMicros` for the same model, which decides a refusal: a cap at it admits a request no job sends. The diff draws each array as three lines, as `JSON.stringify` writes them, and its lines are the golden's. The rest as on TriggerEnvironment.
