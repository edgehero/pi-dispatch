"""Parked with an answerer: a dispatcher that may draft or send answers to parked questions for the person,
from sources the person already decided, with a wait to step in. Planned and proposed. Pulse kit."""
from pulse import *
from gen_watchboard import probs

NAME = "ParkedAnswerer"

def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")

def code(t): return f'<span class="code">{E(t)}</span>'

def src(icon, text):
    return f'<a class="pa-src" href="#">{ic(icon, "ic ic--sm")}<span>{text}</span></a>'

def sect(icon, tone, title, count, note=""):
    return (f'<p class="pa-sect"><span class="tile tile--sm tone-{tone}">{ic(icon, "ic ic--sm")}</span>'
            f'<b>{title}</b><span class="pa-sect__n">{count}</span>{f"<span class=pa-sect__note>{note}</span>" if note else ""}</p>')

# ---------------------------------------------------------------- shared by the desktop, phone and viewer pages
# Each parked question: id, project, target, what ran where, parked at, waiting, the card's tone and glyph.
QA = ("gh-2f6a", "api", "acme/api#131", "triage on mini1, parked at 15:13 UTC", "waiting 26m", "parked", "parked")
QB = ("gh-6e1d", "web", "acme/web#512", "fix on mini2, parked at 15:35 UTC", "waiting 4m", "running", "edit")

def qhead(q, hid):
    jid, _, _, _, waiting, tone, glyph = q
    return f"""  <div class="card__head">
    <span class="tile tone-{tone}">{ic(glyph)}</span>
    <h2 id="{hid}">{code(jid)} asked a question</h2>
    <span class="end">{chip(waiting, 'parked', 'clock')}</span>
  </div>"""

def qwho(q):
    _, project, target, what, *_ = q
    return f'<p class="pa-who">{tag(project)}<a class="link" href="#">{target}</a><span>{what}</span></p>'

def qwhere(target, run_page=True):
    tail = f', or on <a class="link" href="#">its run page</a>' if run_page else ""
    return (f'<p class="pa-where">{ic("info", "ic ic--sm")}<span>The question is the run\'s last message: read it on '
            f'<a class="link" href="#">{target}</a>{tail}.</span></p>')

# ---------------------------------------------------------------- a. yours to answer
Q_A = f"""<section class="card card--ring tone-parked pa-q" id="p-yours" data-panel aria-labelledby="pa-a">
{qhead(QA, "pa-a")}
  {qwho(QA)}
  {qwhere("acme/api#131")}
  <p class="pa-pass">{ic('bolt', 'ic ic--sm')}<span><b>Not answered for you: a product decision.</b> Yours to answer. <span class="faint">draft run <span class="code">gh-91d4</span>, Jev: product_decision 0.88</span></span></p>
  <div class="field">
    <label for="pa-ta">Your answer</label>
    <textarea id="pa-ta" class="textarea" rows="3" placeholder="Write your answer"></textarea>
    <span class="field__hint">Posted as you to acme/api#131 after you confirm. It resumes the run.</span>
  </div>
  <label class="pa-check"><input type="checkbox" id="pa-keep"><span>Keep it as a standing answer, so the next draft can cite it</span></label>
  <div class="pa-act">{btn('Preview answer', 'answer', 'parked', sm=False)}{btn('Open run', 'ghost', sm=False)}</div>
</section>"""

# ---------------------------------------------------------------- b. drafted for you
SOURCES = (src('skill', 'docs/CONTRIBUTING.md at main') + src('comment', 'your answer on acme/web#477, 2 Oct')
           + src('flag', 'standing answer &ldquo;test command&rdquo;'))

Q_B = f"""<section class="card card--ring tone-running pa-q" id="p-drafted" data-panel aria-labelledby="pa-b">
{qhead(QB, "pa-b")}
  {qwho(QB)}
  <div class="pa-draft">
    <p class="pa-draft__h"><span class="badge tone-running">{ic('edit')}Drafted for you</span><span class="faint">by draft run <a class="link code" href="#">gh-a07c</a> at 15:37 UTC, $0.004</span></p>
    <p class="pa-draft__t">The question and the draft are on the run page, beside the transcript.</p>
    <div class="pa-srcs"><span class="pa-srcs__l">From</span>{SOURCES}</div>
  </div>
  <p class="pa-wait__t">{ic('parked', 'ic ic--sm')}<span><b>Waiting for you to send it.</b></span><span class="faint">drafted 2 minutes ago</span></p>
  <div class="pa-why">
    <p class="pa-why__h">{ic('spend', 'ic ic--sm')}<span>Why it may draft: Jev, 2 questions, $0.00002</span></p>
    <div class="pa-why__g">
      <div><p class="pa-why__q">{code('category')}<span>choice</span></p>
        {probs([('convention', .86), ('product_decision', .06), ('security', .02), ('other', .06)], 'convention')}</div>
      <div><p class="pa-why__q">{code('answerable_from_sources')}<span>yes or no</span></p>
        {probs([('yes', .91), ('no', .09)], 'yes')}</div>
    </div>
    <p class="pa-why__n">It drafted because the category is allowed for web and both answers reach 0.80.</p>
  </div>
  <p class="pa-post">{ic('comment', 'ic ic--sm')}<span>When you send it, it posts to acme/web#512 as yours: <b>&ldquo;Answered from the operator console by ops&rdquo;</b>, naming the draft run it came from.</span></p>
  <div class="pa-act">
    {btn('Open the draft', 'answer', 'chev-r', sm=False)}{btn('Answer myself', 'ghost', 'parked', sm=False)}
    {btn("Don't draft these", 'ghost', 'pause', sm=False)}
  </div>
  <p class="pa-onrun">{ic('runs', 'ic ic--sm')}<span>On the run page the draft fills the answer box.</span></p>
</section>"""

# ---------------------------------------------------------------- c. answered for you
Q_C = f"""<section class="card pa-done" id="p-answered" data-panel aria-labelledby="pa-c">
  <h2 class="sr" id="pa-c">Answered for you today</h2>
  <div class="pa-done__r">
    <span class="badge tone-ok">{ic('done')}Sent from a draft</span>
    <span class="pa-done__m">{code('gh-5a02')}{tag('web')}<a class="link" href="#">acme/web#498</a></span>
    <span class="pa-done__q">from standing answer &ldquo;UI components&rdquo;</span>

  </div>
  <p class="pa-done__a"><span>Read the question and its answer on <a class="link" href="#">acme/web#498</a> or the run page.</span><span class="faint">Sent by ops at 14:10 UTC, as drafted, 3 minutes after the draft. The run completed at 14:31 UTC.</span></p>
</section>"""

# ---------------------------------------------------------------- the answerer
STATS = [("11", "sent as drafted"), ("4", "edited, then sent"), ("2", "dropped for your own"), ("9", "passed to you")]

ANSWERER = card(f'{ic("bolt")}Answer rule, row 11', f"""
  <p class="pa-purpose">Draft answers to how-to and convention questions for api and web from what is already decided.</p>
  {facts([
      ("When", f"a run of {tag('api')} or {tag('web')} parks"),
      ("Starts", "a draft job: flow <span class=\"code\">draft-answer</span>, <span class=\"code\">claude-haiku-5-5</span>, read-only tools, $0.05 a job, no status comments"),
      ("Classifies", "with Jev, a tool call inside the job's reserve"),
      ("Sources", '<ul class="pa-list"><li>standing answers you adopted <b>14</b></li><li>the repository at its default branch</li><li>earlier replies on the repository\'s issues</li></ul>'),
  ], cols=1)}
  <p class="pa-h pa-h--top">{ic('pie', 'ic ic--sm')}Last 30 days</p>
  <ul class="pa-stats">{''.join(f'<li><b>{n}</b><span>{t}</span></li>' for n, t in STATS)}</ul>
  <p class="pa-rate">{ic('spend', 'ic ic--sm')}<span><b>11 of 17 drafts sent as written.</b> 26 draft jobs in 30 days cost $0.38.</span></p>
""", end=f'<span class="badge tone-ok">{ic("done")}On</span>', sub="drafts, you send", id_="p-answerer")

# ---------------------------------------------------------------- how much it may do
LEVELS = ["Classify only", "Draft for me", "Send without me"]

def level(project, cur, wait):
    items = []
    for i, l in enumerate(LEVELS):
        on = i == cur
        label = l
        cur_attr = ' aria-current="true"' if on else ""
        locked = i == 2
        mark = ic("done", "ic ic--sm") if on else (ic("shield", "ic ic--sm") if locked else "")
        items.append(f'<li{cur_attr}{" class=pa-lvl--locked" if locked else ""}>{mark}<span>{label}</span></li>')
    return (f'<div class="pa-lvlrow"><span class="pa-lvlrow__p">{tag(project)}</span>'
            f'<ol class="pa-lvl" aria-label="{project}: {LEVELS[cur]}">{"".join(items)}</ol></div>')

ALLOW = ["conventions", "how-to", "already decided"]
NEVER = ["product decisions", "security", "money", "scope"]

LEVEL = card("How much it may do", f"""
  {level('api', 1, '')}
  {level('web', 1, '')}
  <p class="pa-locked">{ic('shield', 'ic ic--sm')}<span><b>Send without me</b> is not allowed: <a class="link" href="#">OQ-051</a>.</span></p>
  <div class="pa-cats">
    <p class="pa-cats__l">May draft</p><p class="pa-cats__c">{''.join(f'<span class="pa-cat tone-ok">{ic("done", "ic ic--sm")}{c}</span>' for c in ALLOW)}</p>
    <p class="pa-cats__l">Never</p><p class="pa-cats__c">{''.join(f'<span class="pa-cat tone-refused">{ic("refused", "ic ic--sm")}{c}</span>' for c in NEVER)}</p>
  </div>
  {diff('triggers.json, row 11, the answer rule', [
      ('ctx', '"answer": { "projects": ["api", "web"], "mode": "draft",'),
      ('ctx', '  "allow": ["convention", "how-to", "decided"],'),
      ('ctx', '  "minConfidence": 0.8 },'),
      ('ctx', '"run": { "flow": "draft-answer", "maxCostUsd": 0.05 }')])}
  <p class="pa-ro">{ic('edit', 'ic ic--sm')}<span>Read only here. <a class="link" href="#">Edit in triggers.json</a></span></p>
""", sub="per project, set by you", id_="p-level")

# ---------------------------------------------------------------- standing answers
STANDING = [("test command", "pnpm test:ci for the CI suite; never the watch mode", "2 Oct", 6),
            ("branch names", "pi/issue-&lt;number&gt;, one branch per issue", "12 Sep", 9),
            ("UI components", "reuse components/ from the design system; no new UI library", "20 Sep", 4),
            ("migrations", "one migration per pull request; never edit an old one", "28 Sep", 2)]

def standing_rows():
    return "".join(f"""<li class="pa-st">
  <span class="pa-st__n">{ic('flag', 'ic ic--sm')}<b>{n}</b></span>
  <span class="pa-st__a">{a}</span>
  <span class="pa-st__m">adopted {d} · used {u} times</span>
</li>""" for n, a, d, u in STANDING)

STAND = card("Standing answers", f"""
  <ul class="pa-sts">{standing_rows()}</ul>
  <p class="pa-more"><a class="link" href="#">All 14 standing answers</a></p>
  <div class="pa-act">{btn('Add a standing answer', '', 'plus')}</div>
  <p class="pa-foot">Add one by hand, or tick <i>Keep it as a standing answer</i> when you send one.</p>
""", sub="adopted by you", id_="p-standing")

# ---------------------------------------------------------------- page
def page():
    main = (sect('parked', 'parked', 'Yours to answer', '1')
            + Q_A
            + sect('edit', 'running', 'Drafted for you', '1', 'waiting for you to send')
            + Q_B
            + sect('done', 'ok', 'Sent from a draft today', '1')
            + Q_C)
    side = ANSWERER + LEVEL + STAND
    inner = f'<div class="cols"><div class="stack">{main}</div><div class="stack">{side}</div></div>'
    end = '<div class="seg" role="group" aria-label="Show"><button aria-pressed="true">Questions <b>2</b></button><button aria-pressed="false">Approvals</button></div>'
    return shell("Parked", inner, "Parked", sub="Runs that stopped to wait for a person. An answer rule may draft answers; you send them.",
                 end=end, parked=2)

SHOW = '<div class="seg" role="group" aria-label="Show"><button aria-pressed="true">Questions <b>2</b></button><button aria-pressed="false">Approvals</button></div>'

# ---------------------------------------------------------------- the phone: two cards, one action each
def phone_page():
    a = f"""<section class="card card--ring tone-parked pa-q" id="p-yours" data-panel aria-labelledby="pa-a">
{qhead(QA, "pa-a")}
  {qwho(QA)}
  {qwhere("acme/api#131")}
  <p class="pa-pass">{ic('bolt', 'ic ic--sm')}<span><b>Not answered for you: a product decision.</b> Yours to answer.</span></p>
  <div class="field"><label for="pa-ta">Your answer</label><textarea id="pa-ta" class="textarea" rows="3" placeholder="Write your answer"></textarea></div>
  <div class="pa-act">{btn('Preview answer', 'answer', 'parked', sm=False)}</div>
</section>"""
    b = f"""<section class="card card--ring tone-running pa-q" id="p-drafted" data-panel aria-labelledby="pa-b">
{qhead(QB, "pa-b")}
  {qwho(QB)}
  <div class="pa-draft">
    <p class="pa-draft__h"><span class="badge tone-running">{ic('edit')}Drafted for you</span><span class="faint">by <a class="link code" href="#">gh-a07c</a> at 15:37 UTC</span></p>
    <p class="pa-draft__t">The question and the draft are on the run page.</p>
    <div class="pa-srcs"><span class="pa-srcs__l">From</span>{SOURCES}</div>
  </div>
  <p class="pap-jev">{ic('spend', 'ic ic--sm')}<span>Jev: {code('convention')} 0.86, answerable from sources 0.91</span></p>
  <div class="pa-act">{btn('Open the draft', 'answer', 'chev-r', sm=False)}</div>
</section>"""
    done = (f'<p class="collapsed" id="p-answered" data-panel>{ic("done", "ic ic--sm")}<b>Sent from a draft today:</b> '
            f'{code("gh-5a02")} on <a class="link" href="#">acme/web#498</a>, by ops at 14:10 UTC.</p>')
    rule = (f'<p class="collapsed" id="p-answerer" data-panel>{ic("bolt", "ic ic--sm")}<b>Answer rule, row 11</b> drafts for api and web; '
            f'you send. <a class="link" href="#">Open</a></p>')
    inner = ('<div class="stack">' + sect('parked', 'parked', 'Yours to answer', '1') + a
             + sect('edit', 'running', 'Drafted for you', '1') + b + done + rule + '</div>')
    return shell("Parked", inner, "Parked", sub="Runs waiting for a person. An answer rule may draft; you send.", end=SHOW, parked=2)

# ---------------------------------------------------------------- the viewer: that questions wait, never what they say
def viewer_page():
    def vcard(q, hid, state):
        return f"""<section class="card card--ring tone-{q[5]} pa-q" aria-labelledby="{hid}">
{qhead(q, hid)}
  {qwho(q)}
  {qwhere(q[2], run_page=False)}
  {state}
</section>"""
    a = vcard(QA, "pv-a", f'<p class="pav-st">{ic("parked", "ic ic--sm")}<span><b>Waiting for an answer.</b> An operator answers it.</span></p>')
    b = vcard(QB, "pv-b", f'<p class="pav-st">{badge("running", "A draft is ready")}<span>An operator reads and sends it.</span></p>')
    done = (f'<p class="collapsed" id="p-answered" data-panel>{ic("done", "ic ic--sm")}{code("gh-5a02")} on '
            f'<a class="link" href="#">acme/web#498</a> was <b>answered by ops</b>, from a draft, at 14:10 UTC. The run completed at 14:31 UTC.</p>')
    note = (f'<p class="collapsed">{ic("info", "ic ic--sm")}<b>Answers, drafts and their sources</b> are for operators, '
            'and so is the answer rule.</p>')
    inner = ('<div class="stack">' + sect('parked', 'parked', 'Waiting for a person', '2')
             + f'<div class="cards-2 pav-grid">{a}{b}</div>'
             + sect('done', 'ok', 'Answered today', '1') + done + note + '</div>')
    return shell("Parked", inner, "Parked", sub="Runs that stopped to wait for a person.", end=SHOW, parked=2, role="viewer")

VARIANT_CSS = """
.pap-jev { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pap-jev > .ic { flex: none; margin-top: 2px; color: var(--running-ink); }
.pap-jev .code { font-size: 12px; color: var(--ink); }
.pav-grid { align-items: start; }
.pav-st { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.pav-st > .ic { flex: none; color: var(--parked-ink); }
.pav-st b { color: var(--ink); }
#p-answered.collapsed .code, #p-answerer.collapsed .code { font-size: 13px; }
@media (max-width: 760px) { .pav-grid { grid-template-columns: minmax(0, 1fr); } }
"""

CSS = """
.seg b { font-weight: 800; }
.pa-sect { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 6px 4px -4px; font-size: 14px; color: var(--ink); }
.pa-sect__n { font-weight: 800; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.pa-sect__note { font-size: 12px; color: var(--ink-muted); }
.pa-q { display: grid; gap: var(--space-4); }
.pa-q .card__head { margin-bottom: 0; }
.pa-q h2 .code { font-size: 17px; font-weight: 700; }
.pa-who { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--ink-muted); }
.pa-quote { padding: 16px 20px; border-radius: var(--radius-md); background: var(--parked-tint); font-size: 20px; line-height: 29px; font-weight: 600; letter-spacing: -0.01em; }
.pa-quote--sm { font-size: 17px; line-height: 25px; }
.pa-pass { display: flex; align-items: flex-start; gap: 8px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.pa-pass > .ic { flex: none; margin-top: 2px; color: var(--ink); }
.pa-pass b { color: var(--ink); }
.pa-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.pa-check input { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--primary); }
.pa-act { display: flex; gap: 8px; flex-wrap: wrap; }
.pa-draft { display: grid; gap: 10px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); box-shadow: inset 3px 0 0 var(--running); }
.pa-draft__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.pa-draft__t { font-size: 15px; line-height: 22px; font-weight: 650; color: var(--ink); }
.pa-draft__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-where, .pa-onrun { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.pa-where .ic, .pa-onrun .ic { flex: none; margin-top: 3px; }
.pa-onrun { font-size: 12px; line-height: 18px; }
.pa-onrun b { color: var(--ink); font-weight: 650; }
.pa-srcs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pa-srcs__l { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin-right: 2px; }
.pa-src { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 3px 10px; border-radius: var(--radius-pill); background: var(--surface); color: var(--ink); font-size: 12px; font-weight: 600; text-decoration: none; box-shadow: inset 0 0 0 1px var(--line); }
.pa-src .ic { flex: none; color: var(--running-ink); }
.pa-src:hover { box-shadow: inset 0 0 0 1px var(--line-strong); }
.pa-wait { display: grid; gap: 6px; }
.pa-wait__t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--ink); }
.pa-wait__t > .ic { color: var(--running-ink); }
.pa-wait__t .faint { margin-left: auto; font-size: 12px; }
.pa-wait .pbar { width: 100%; display: block; }
.pa-why { display: grid; gap: 10px; padding-top: var(--space-3); border-top: 1px solid var(--line); }
.pa-why__h { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; color: var(--ink); }
.pa-why__h > .ic { color: var(--running-ink); }
.pa-why__g { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: var(--space-5); }
.pa-why__q { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 12px; color: var(--ink-muted); }
.pa-why__q .code { font-size: 12px; color: var(--ink); }
.pa-why__n { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-why .wb-p { grid-template-columns: 124px minmax(0, 1fr) 34px; }
.pa-post { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-post > .ic { flex: none; margin-top: 2px; }
.pa-post b { color: var(--ink); font-weight: 600; }
.pa-done { display: grid; gap: 10px; }
.pa-done__r { display: flex; align-items: center; gap: 10px 12px; flex-wrap: wrap; font-size: 13px; color: var(--ink); }
.pa-done__m { display: inline-flex; align-items: center; gap: 8px; }
.pa-done__m .code { font-weight: 700; }
.pa-done__q { font-weight: 650; }
.pa-done__end { display: inline-flex; align-items: center; gap: 10px; margin-left: auto; font-size: 12px; }
.pa-done__a { display: grid; gap: 2px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; line-height: 19px; color: var(--ink); }
.pa-done__a .faint { font-size: 12px; }
.pa-done__n { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-done__n > .ic { flex: none; margin-top: 2px; }
.wb-probs { display: grid; gap: 6px; }
.wb-p { display: grid; grid-template-columns: 92px minmax(0, 1fr) 34px; gap: 8px; align-items: center; font-size: 12px; color: var(--ink-muted); }
.wb-p__o { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-p--on .wb-p__o { color: var(--ink); font-weight: 700; }
.wb-p--on .ic { color: var(--running-ink); flex: none; }
.wb-p__b { width: 100%; display: block; }
.wb-p__bed { fill: var(--surface-3); }
.wb-p__fill { fill: var(--ink-faint); }
.wb-p--on .wb-p__fill { fill: var(--running); }
.wb-p b { text-align: right; color: var(--ink); font-variant-numeric: tabular-nums; }
#p-answerer .card__head h2 { display: inline-flex; align-items: center; gap: 8px; }
#p-answerer .card__head h2 .ic { color: var(--running-ink); }
.pa-purpose { margin-bottom: var(--space-3); font-size: 15px; line-height: 22px; font-weight: 600; color: var(--ink); }
.pa-list { display: grid; gap: 2px; }
.pa-list b { font-variant-numeric: tabular-nums; }
.pa-h { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; font-weight: 700; color: var(--ink); }
.pa-h--top { margin-top: var(--space-4); }
.pa-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.pa-stats li { display: grid; gap: 2px; align-content: start; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 11px; line-height: 15px; color: var(--ink-muted); }
.pa-stats b { font-size: 24px; line-height: 28px; font-weight: 750; color: var(--ink); font-variant-numeric: tabular-nums; }
.pa-rate { display: flex; align-items: flex-start; gap: 8px; margin-top: var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-rate > .ic { flex: none; margin-top: 2px; }
.pa-rate b { color: var(--ink); }
.pa-lvlrow { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 10px; align-items: center; margin-bottom: 8px; }
.pa-lvl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--surface-2); }
.pa-lvl li { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 34px; padding: 4px 8px; border-radius: 10px; font-size: 12px; line-height: 15px; font-weight: 650; color: var(--ink-muted); text-align: center; }
.pa-lvl li.pa-lvl--locked { color: var(--ink-faint); box-shadow: inset 0 0 0 1px var(--line); }
.pa-locked { display: flex; gap: 8px; align-items: flex-start; margin: 4px 0 var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-locked .ic { flex: none; margin-top: 2px; color: var(--ink); }
.pa-locked b { color: var(--ink); }
.pa-lvl li[aria-current] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.08), inset 0 0 0 1.5px var(--running); }
.pa-lvl li[aria-current] .ic { flex: none; color: var(--running-ink); }
.pa-cats { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px 10px; align-items: center; margin: var(--space-4) 0; }
.pa-cats__l { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.pa-cats__c { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.pa-cat { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--ink); }
.pa-cat .ic { color: var(--tone-ink); }
.pa-ro { display: flex; align-items: flex-start; gap: 8px; margin-top: var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-ro > .ic { flex: none; margin-top: 2px; }
.pa-sts { display: grid; }
.pa-st { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 10px 0; border-top: 1px solid var(--line); font-size: 13px; }
.pa-st:first-child { border-top: 0; padding-top: 0; }
.pa-st__n { display: inline-flex; align-items: center; gap: 6px; color: var(--ink); }
.pa-st__n .ic { flex: none; color: var(--ink-muted); }
.pa-st__a { color: var(--ink); }
.pa-st__m { font-size: 12px; color: var(--ink-muted); }
.pa-more { margin-top: 6px; font-size: 13px; }
.pa-prop { display: grid; gap: 8px; margin-top: var(--space-4); padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); box-shadow: inset 3px 0 0 var(--parked); }
.pa-prop__h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14px; color: var(--ink); }
.pa-prop__a { font-size: 15px; font-weight: 600; color: var(--ink); }
.pa-prop__why { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-foot { margin-top: var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.pa-foot b { color: var(--ink); }
@media (max-width: 760px) {
  .pa-quote { font-size: 17px; line-height: 25px; padding: 12px 14px; }
  .pa-quote--sm, .pa-draft__t { font-size: 16px; line-height: 23px; }
  .pa-why__g { grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
  .pa-act .btn { flex: 1 1 auto; }
  .pa-wait__t .faint { margin-left: 0; width: 100%; }
  .pa-done__end { margin-left: 0; }
  .pa-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pa-lvlrow { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .pa-lvl { grid-template-columns: minmax(0, 1fr); }
  .pa-lvl li { justify-content: flex-start; }
  .pa-cats { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .pa-st { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .pa-st__m { white-space: normal; }
  .titlebar__end { flex-wrap: wrap; }
  #p-level .diff__b > span { white-space: pre-wrap; }
}
"""

README = """
The Parked page with an answer rule (proposed): when a run of a listed project parks, the worker starts a draft job that classifies the question and drafts an answer from cited sources. A person sends it, edits it, or answers otherwise. Product decisions, security, money, scope and every approval are never drafted.

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

**Fixture note.** gh-2f6a, acme/api#131, triage on mini1 and parked 26 minutes come from the fixture. Everything else is sample, because answer rules are proposed (issue #753, REQ-PARKED-ANSWERER):
- the rule and its numbers;
- gh-6e1d, gh-5a02, the draft runs gh-91d4 and gh-a07c, and their sources;
- the standing answers;
- the probabilities and costs.

The Parked count in the nav is 2: both questions wait for the person.
"""

if __name__ == "__main__":
    write(NAME, card_marker("Planned and proposed", 2260, 1440,
                            "Parked with an answer rule: a draft job drafts answers from what you already decided and cites its sources; you send them"),
          "Parked, with an answer rule", page(), CSS)
    readme(NAME, README)
    write("ParkedDraftPhone", card_marker("Phone", 1560, 390, "Parked on a phone with a drafted answer: two cards, where to read each question, the draft's sources, one action each"),
          "Parked on a phone, with a draft", phone_page(), CSS + VARIANT_CSS)
    readme("ParkedDraftPhone", """
The Parked page on a phone, with an answer rule drafting (proposed). Two questions wait; each card has one action, and neither shows the question or the draft.

**How a person uses it.**
- **Yours to answer.** gh-2f6a on acme/api#131: where to read the question (the issue, or its run page), why no draft was made ("a product decision"), the answer box and **Preview answer**.
- **Drafted for you.** gh-6e1d on acme/web#512: the draft run that made it (gh-a07c), the sources it cites by name, Jev's two answers in one line, and **Open the draft**, which opens the run page where the draft fills the answer box. Sending is the usual preview and Confirm.
- **Sent from a draft today** and **the answer rule** are one line each.

**Panels.** `p-yours`, `p-drafted`, `p-answered` (one line), `p-answerer` (one line).

**The server provides.** The same reads as ParkedAnswerer. The phone leaves out *Answer myself*, *Don't draft these*, the standing answers and the rule's settings, which are one tap away on the run page and the rule's page.

**Who sees what.** An operator's phone. A viewer's phone shows ParkedDraftViewer's content, stacked.

**Fixture note.** As ParkedAnswerer: gh-2f6a, acme/api#131, triage on mini1 and parked 26 minutes are the fixture; gh-6e1d, gh-5a02, gh-a07c and the sources are sample, because answer rules are proposed (issue #753, REQ-PARKED-ANSWERER).
""")
    write("ParkedDraftViewer", card_marker("Planned and proposed", 900, 1440, "Parked as a viewer sees it: that two questions wait and for how long, that one has a draft, and who answered the earlier one"),
          "Parked, as a viewer", viewer_page(), CSS + VARIANT_CSS)
    readme("ParkedDraftViewer", """
The Parked page as a viewer sees it, with an answer rule drafting (proposed). A viewer learns that runs wait for a person and for how long, never what they asked or what was drafted.

**How a person uses it.**
- **Waiting for a person, 2.** One card per question: the run, its project and target, what ran where, when it parked and how long it has waited, and where the question can be read (its issue). gh-2f6a waits for an answer; gh-6e1d has a draft ready, which an operator reads and sends.
- **Answered today.** gh-5a02 on acme/web#498 was answered by ops, from a draft, and the run completed.
- One line says answers, drafts, their sources and the answer rule are for operators.

**Panels.** The two question cards, `p-answered` (one line), and the operators-only line.

**The server provides.** For a viewer's session: each parked run's id, project, target, flow, host, parked time and wait, whether a draft exists, and who answered a finished one. Never the question, the draft, its sources, Jev's classification, why a draft was not made, the answer form or the rule.

**Who sees what.** This is the viewer's page: no forms, no actions, no answer-rule card. "Why no draft was made" (a product decision) is a classification, so it is left out too.

**Fixture note.** As ParkedAnswerer: gh-2f6a and acme/api#131 are the fixture; gh-6e1d and gh-5a02 are sample (issue #753).
""")
    print("answerer written")
