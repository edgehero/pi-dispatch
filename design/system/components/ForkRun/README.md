A finished run's page in fork mode (#648): pick a transcript entry, choose the model and thinking level, see the estimated cost against the job cap, and start a fork on its own branch.

## How a person uses it
- The *Forks of this run* tree at the top shows the original run and its forks. Each node gives the fork point, the model, and the cost or elapsed time, so earlier attempts are visible before starting another.
- In the transcript, every entry has **Fork from here**. The chosen entry is ringed in violet and marked *fork point*; tool results stay folded.
- The *Fork this run* card holds the rest:
  - the chosen point, with Change;
  - before-or-at the entry;
  - the model, from the deployment's allowed models, and the thinking level;
  - an optional message to the agent;
  - the cost estimate as a range, with a bar against the job cap (attention when it nears the cap);
  - the new branch name;
  - a note that earlier edits come back from the run's checkpoint.
- **Start fork** sits behind a paid preview. The preview says what is reserved before the first token, that the original pull request is untouched, and that a comment links both attempts.

## Panels
`p-forks`, `p-transcript`, `p-fork`.

## The server provides
The promoted session's transcript entries with ids and kinds, existing forks (`fork: {fromJob, fromEntry, model}`), the allowed models, a cost estimate from past runs of the same flow and repository per model, the job cap and today's dollar window, the branch name it will use, and whether a workspace checkpoint exists for the chosen point.

## Fixture note
All fork content is sample, because forking is planned for 5.0.0: gh-b3d7 is shown as completed (in the fixture it is still running), and gh-b3d7-f1, gh-b3d7-f2, the transcript entries 10 to 18, the costs and the estimate are illustrative. Entry 14's text and the first read come from the fixture's live transcript.
