The Parked page with an answer rule (answer rules): when a run of a listed project parks, the worker starts a draft job that classifies the question and drafts an answer from cited sources. A person sends it, edits it, or answers otherwise. Product decisions, security, money, scope and every approval are never drafted.

**How a person uses it.**
- **No question or draft text on this page.** Each card says where to read the question and links to the runs.
- **The page groups questions by who acts next.**
  - **Yours to answer.** gh-2f6a on acme/api#131. Its draft run passed it on with one line saying why ("Not answered for you: a product decision") and Jev's classification. The usual answer box and **Preview answer** follow, plus a box to keep the answer as a standing answer, so the next draft can cite it.
  - **Drafted for you.** gh-6e1d on acme/web#512. The card names its draft run (gh-a07c) and lists the draft's sources by name: the repository doc at main, the person's own earlier reply, and a standing answer. *Why it may draft* shows Jev's two questions with their probabilities: `category` (convention 0.86) and `answerable_from_sources` (yes 0.91), and the 0.80 bar both must clear. It says it waits for the person.
  - **Open the draft** opens the parked run's page, where the draft fills the answer box. The person sends it with the usual **Preview answer** and Confirm, edits it first, or writes their own. It posts as theirs: "Answered from the operator console by ops", naming the draft run it came from. **Answer myself** drops the draft, and **Don't draft these** proposes a narrower `allow` for review.
  - **Sent from a draft today.** gh-5a02 on acme/web#498, collapsed to one row: sent by ops as drafted, from the standing answer "UI components". It is still the person's answer, and a touch in Zero touch.
- **The answer rule** (side). Its purpose; when it fires; the draft job it starts (flow, model, read-only tools, a $0.05 cap, no status comments); Jev as a tool call inside the job's reserve; its sources. Then its last 30 days: 11 drafts sent as written, 4 edited, 2 dropped, 9 passed on, and what the draft jobs cost.
- **How much it may do.** Per project: *Classify only*, *Draft for me* (both projects), and *Send without me*, shown locked with a link to OQ-051. Two lists name the categories it may draft and those it never drafts, each with a glyph and a word. The triggers.json rows are shown read only, with **Edit in triggers.json**: no tool may set the rule.
- **Standing answers** (side). Answers the person wrote, with when and how often each was cited. They are added by hand or by ticking the box when sending an answer, through a preview and Confirm audited as `standing-answer-add`.

**Panels.** `p-yours`, `p-drafted`, `p-answered`, `p-standing`, `p-answerer`, `p-level`.

**The server provides.**
- **Today:** the parked runs, where each question is read (never its text), whether an answer can be built here, and the console answer path. An operator's answer is posted as "Answered from the operator console by <token name>" and resumes the run.
- **New, for an answer rule:**
  - the rule in triggers.json (projects, mode, allowed categories, minimum confidence, and the draft job's flow, model and cap), which no tool may set;
  - a draft job per parked question, as an ordinary forge job with no status comments;
  - per question: the verdict (drafted or passed with a reason), Jev's questions with options and probabilities, the sources by name, and the draft run's id; the draft itself only to the run pages;
  - the answer box on the run page filled from the draft;
  - standing answers with when added and how often cited;
  - 30-day counts (sent as drafted, edited, dropped, passed on) and the draft jobs' cost.

**Who sees what.** A viewer sees that a question waits, how long, that a draft exists, and who answered. A viewer never sees the question text, drafts, sources, Jev's classification, standing answers or the triggers.json rows, and has no actions.

**Why it works this way.**
- **The person sends every answer**, through the same preview and Confirm as any answer, under their own session; the audit row names them.
- **Send without me is locked.** The constitution lets a console answer through only on a person's confirm, so a model sending on its own needs that changed first (OQ-051).
- **The draft is a job**, in its own container, with a scoped token and no queue access, reserved before it calls a model.
- **The question is data.** It came from a run that read issue text, so the draft job classifies it and never follows instructions inside it.
- **Only from listed sources, always cited.** No source, no draft: it passes the question to the person.
- **A draft cannot widen the run.** The run resumes with the same trigger, caps, tools and model. An answer is text, not config.
- **What it never does.** It never sends an answer, drafts for an approval (#649), drafts product decisions, security, money or scope, drafts what its sources do not cover, or changes the run's trigger, caps, tools or model.
- **No question or draft text on the Parked page.** Both are the run's own text, which the console shows on the run pages and nowhere else (REQ-CONSOLE-SECURITY (l); the shipped Parked page already draws no question).
- **Still a touch.** A draft the person sends counts as a touch in Zero touch, a quicker one. The way to zero is removing the question.
- **No rule edits here.** The rule is written by hand in triggers.json, and no tool may set it.
- **Jev gives no reasons.** The cited sources are the why.

**Fixture note.** gh-2f6a, acme/api#131, triage on mini1 and parked 26 minutes come from the fixture. Everything else is sample, because answer rules are implemented under issue #772 (REQ-PARKED-ANSWERER):
- the rule and its numbers;
- gh-6e1d, gh-5a02, the draft runs gh-91d4 and gh-a07c, and their sources;
- the standing answers;
- the probabilities and costs.

The Parked count in the nav is 2: both questions wait for the person.
