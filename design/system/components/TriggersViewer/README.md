Triggers as a viewer sees them. The rules, their runs and the check are the same as an operator's page; nothing on it writes.

**How a person uses it.**
- **The numbers**, the week strip and every rule, read as on the operator's page: when, runs, what it adds, the last run and the next fire.
- **Which rule would run?** stays. It reads the triggers file and the gates and writes nothing, so a viewer may run it.
- A row still opens the trigger's own page, which a viewer reads without its Edit, Delete or Fire now.
- One line under the tabs says what is the operator's.

**Panels.** `p-tr-viewer`, `p-tr-count`, `p-tr-next`, `p-tr-spend`, `p-tr-week`, `p-tr-schedule`, `p-tr-github`, `p-tr-gitlab`, `p-tr-check`.

**Who sees what.** Left out for a viewer: *Add a trigger*, any edit, *Fire now* (on a trigger's page), and dispatcher proposals (on the Dispatchers tab, proposed). The subtitle names the triggers file without its folder.

**Fixture note.** The same fixture as TriggersScreen: the seven rules and their last runs, from one list in `gen_triggers.py`.
