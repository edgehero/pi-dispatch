A guide card, not a console screen: one picture of how the pieces fit, read left to right.

**How a person uses it.**
- **What starts work.** Triggers (cron, label, comment, issue and pull request rules, written by hand), the CLI, and the planned watch rules (#735) and proposed dispatchers, drawn dashed.
- **Queue and host.** The queue holds a job until a slot is free. A worker on a host takes it after the caps are checked, and a venue runs it in one container.
- **The run.** It becomes a run with a record, and ends completed, failed, refused or parked. Waiting for approval (#649) is planned.
- **Where a person steps in.** Each outcome points at what a person does next: steer or cancel while it runs, merge the pull request (always theirs), open the sandbox, re-run, answer the question, send a drafted answer (#753, proposed), decide an approval (#649, planned).
- **What is counted.** Spend against caps, reserved before any model call, and touches (Zero touch, #753, proposed).
- **The legend** says what solid, dashed blue, dashed grey, a violet edge and a tint mean. Every planned or proposed box also says so in words, with its issue.
- **On a phone** the map becomes the same content as a list, in the same five groups.

**Panels.** `p-cm-map`.

**Fixture note.** No sample data: the map names kinds of things, not runs.
