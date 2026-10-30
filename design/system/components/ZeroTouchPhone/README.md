The Zero touch tab laid out for a phone rather than stacked: what the rate is first, then where it comes from, then what to do about it.

**How a person uses it.**
- **Touch rate.** The big number, its 8-week trend, the goal and the change, then four short lines: the longest streak, the time runs waited, the answers sent from a draft, and the run waiting now.
- **By project.** One row per project, tappable: its rate with a word (*Under goal*, *Above goal*, *High*), how many runs needed a person, its most common cause and the change against the 30 days before. A row opens the project's own view.
- **What needed a person.** One bar for all projects, each segment with its count, and the six causes as a list. Merging is never a touch.
- **Questions it keeps asking** (operator only). Each group in one row: how often it was asked, its name, its state (*Open*, *Product decision*, *Fixed*) and one action: *Add to instructions*, *Answer gh-2f6a*, *Name this group*, or *See the fix*. The one relevant action opens the group's editor; the preview and diff use the console's confirmed-write flow. The group's title links to its source run.
- **Fixes that worked** is one line, with how far each fix brought its cause down.

**Panels.** `p-zt-rate`, `p-zt-projects`, `p-zt-causes`, `p-zt-questions`, `p-zt-fixes` (one line).

**The server provides.** The same reads as ZeroTouchScreen; the phone drops the per-project bars and the repository rows, which open from a project.

**Who sees what.** An operator's phone. A viewer's phone shows ZeroTouchViewer's content in this order, without the question groups.

**Fixture note.** As ZeroTouchScreen: built by #770, all illustrated values sample, with gh-2f6a and the projects from the fixture.
