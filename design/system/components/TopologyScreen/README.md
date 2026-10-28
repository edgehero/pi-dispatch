The Flows map shows which trigger starts which flow, what chains to what, and what nothing reaches, so a person can find a dead flow, a risky trigger or a chain before it costs money.

**How a person uses it.**
- **Groups.** One box per local folder (its last folder name and HEAD) and one per forge ("unverifiable from this host", with the repositories its runs ran against).
- **Triggers** are pills with a glyph for their kind (cron, label, comment, pull request, issue), their run count in the 30-day map window and their spend in the spend window (or `plan:<id>`). A spent one-shot is faded and dashed and names the run that spent it.
- **Flows** are rounded boxes:
  - solid when the skill was found at HEAD;
  - dashed grey when it is unverified (a forge repository is not readable from this host);
  - dashed amber when it is not at HEAD;
  - dashed red when it is missing;
  - faded when it is an orphan.
- **Wires:** config (the trigger names this flow), observed (a thicker line with "6× · 12h ago", chained in run records), potential (dashed "mention"), and the cron re-arm loop with its schedule.
- **Badges:** a dot for unread, injected ai-trigger or PR spend-loop risk, and a ring for chainable. Each also says so in its tooltip and in the key.
- **Selecting a chip** fills it, outlines its flow and dims the rest. The side card shows the chip's details: schedule, flow, folder, runs and the last outcome, next fire, spend, whether it can chain, what it chains to, and loops in the skill.
- **Moving around.** Map or List view, zoom buttons, drag to pan. Tab reaches every chip and Enter selects it; Escape clears.
- **Not on the map** counts what is missing from it: unattributed runs, refused chain requests and labels moved into tooltips. When the triggers file is missing or invalid, a red banner says so and nothing is drawn.
- The tab row under the title (Spend, Budget split, Capacity, Breakdown, Flows map) is shared by all five Spend views; the current one is filled. They are server-rendered links (`/insights`, `/insights/budget-split`, `/insights/capacity`, `/insights/breakdown`, `/insights/flows`, proposed routes) and on a phone the row scrolls inside itself.

**Viewers** see the same map; full local paths are an operator opt-in.

**Panels.** `p-flows`, `p-flows-key`, `p-flows-selected`, `p-flows-honesty`.

**The server provides.** The graph model: groups, nodes with their kind and flags, edges with kind and counts, run counts per trigger, the spend map, next fire and overdue per cron trigger, and the honesty counters. The map is inline SVG in a viewBox; at 390px it keeps its size and scrolls sideways inside its card.

**Why it works this way.**
- Skills of forge repositories cannot be read from this host, so their flows are drawn dashed as unverified, never as missing.
- Chains are bounded: depth at most 1, at most 2 requests per job, same folder only. A chain wire counts the last 30 days of run records.
- Run counts on the chips use the 30-day map window, and spend uses the 7-day spend window, as the line under the tabs says.
- The map works without a mouse: drag to pan, scroll or the buttons to zoom, Tab to a chip, Enter to select it and Escape to clear. The List view holds the same content as text.

**Fixture note.** The seven triggers, their flows, the folders `site` and `pm`, the forges and their repositories match Configuration. These are sample: the HEAD hashes, the skills tidy-report, deps-bump and old-migrate, the chain and mention wires, the run counts, the spend badges and the spent one-shot.
