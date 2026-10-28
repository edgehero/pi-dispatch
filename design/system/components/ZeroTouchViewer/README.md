The Zero touch tab as a viewer sees it. The same numbers as the operator's page, so a viewer can follow a project towards zero touch; nothing on it acts, and nothing on it quotes a run.

**How a person uses it.**
- **The numbers.** Touch rate, the zero-touch streak, the time runs waited for a person and the answers sent from a draft, as on the operator's page. The waiting run is named by its id.
- **By project.** The same rows and meters, opening to repositories. There is no *Open as runs* link: it leads to the Runs tab's actions.
- **What needed a person.** The same bars and the six causes with their counts.
- **Fixes that worked.** What changed and what it did, before and after. Who made the change is left out (that is the audit log's, which a viewer never sees), and so is the text of an instruction: "Trigger 3's instructions gained a sentence".
- **Questions it keeps asking** is one line saying it is for operators.

**Panels.** `p-zt-rate`, `p-zt-streak`, `p-zt-wait`, `p-zt-handled`, `p-zt-projects`, `p-zt-questions` (one line), `p-zt-causes`, `p-zt-fixes`.

**The server provides.** The operator page's reads, for a viewer's session: the rates, counts, causes, streaks and the fixes log, without the person on each fix, the instruction text, the question groups or any action.

**Who sees what.** This is the viewer's page. The Sandboxes tab is not in the tab row: it is an operator's tab, because a kept workspace holds issue text.

**Fixture note.** As ZeroTouchScreen: proposed (issue #753, REQ-ZERO-TOUCH-RATE), all of it sample, with gh-2f6a and the projects from the fixture.
