"""Last build step: put every card in its area group and set its height to the measured page height.
Run after any generator, because generators write their own provisional group and height."""
import re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shoot import harness
from playwright.sync_api import sync_playwright

from paths import COMPONENTS as ROOT
GROUPS = {
    "Start here": ["ConceptMap", "Glossary", "SampleStory", "JourneyAnswer", "JourneyFailure", "JourneySetup"],
    "Overview": ["OverviewScreen", "OverviewAllClear", "SetupScreen"],
    "Runs": ["RunsScreen", "RunLive", "RunEnded", "RunRefused", "RunParked", "RunRecovered", "RunSandboxed", "RunChatStates", "RunViewer", "ForkRun"],
    "Fleet": ["FleetScreen", "FleetPartPaused", "HostDetail", "VenueDetail", "FleetViewer"],
    "Spend": ["SpendScreen", "SpendBudgetSplit", "SpendCapacity", "SpendBreakdown", "TopologyScreen"],
    "Triggers": ["TriggersScreen", "TriggerDetail", "TriggerEditor", "TriggersViewer", "WatchScreen", "WatchBoard"],
    "Configuration": ["ConfigScreen", "SecretsScreen", "ConnectionsScreen", "ProjectDetail"],
    "Access and audit": ["SignIn", "AccessStates", "AuditScreen", "ErrorPage"],
    "Phone": ["OverviewPhone", "RunsPhone", "ParkedPhone", "SpendPhone", "RunLivePhone", "FleetPhone", "TriggersPhone",
              "ParkedDraftPhone", "ZeroTouchPhone"],
    "Planned and proposed": ["ApprovalRequest", "ModelsScreen", "DispatchersScreen", "DispatcherScreen",
                             "SandboxesScreen", "ZeroTouchScreen", "ZeroTouchViewer", "ParkedAnswerer", "ParkedDraftViewer"],
    "Components": ["Shell", "Status", "Actions", "CardsAndBanners", "DataTable", "FactsAndLevels", "TimelineAndWaitlists",
                   "Transcript", "FieldsDiffCommand", "ConfirmStates", "LiveStates"],
}
WHERE = {n: g for g, ns in GROUPS.items() for n in ns}

# Design status, drawn as a dashed ribbon above each screen card: what is in main, what an open issue plans, what is
# only proposed, and what waits for a decision. Component cards carry none: they are the kit, built in #740.
BUILT, PLANNED, PROPOSED, DECIDE = "built", "planned", "proposed", "decide"
WORD = {BUILT: ("ok", "done", "Built"), PLANNED: ("running", "clock", "Planned"), PROPOSED: ("idle", "edit", "Proposed"),
        DECIDE: ("attention", "attention", "Needs a decision")}
STATUS = {
    "OverviewScreen": (BUILT, "In main since #745."), "OverviewAllClear": (BUILT, "In main since #745."),
    "OverviewPhone": (BUILT, "In main since #745."),
    "SetupScreen": (PROPOSED, "No issue yet. Today the overview draws the first-run checklist (#745); setting up from the browser is new."),
    "RunsScreen": (BUILT, "In main since #746."), "RunsPhone": (BUILT, "In main since #746."),
    "ParkedPhone": (BUILT, "In main since #746, except the question text: the shipped page sends you to the run page to read it."),
    **{n: (BUILT, "Built by #747; managed forks added by #648. Watch remains separate work.") for n in ["RunLive", "RunEnded", "RunRefused", "RunParked", "RunRecovered",
                                                      "RunSandboxed", "RunChatStates", "RunViewer"]},
    **{n: (BUILT, "Built by #748, Fleet with host and venue detail.") for n in ["FleetScreen", "FleetPartPaused", "HostDetail", "VenueDetail"]},
    **{n: (BUILT, "Built by #749, Spend as five views.") for n in ["SpendScreen", "SpendBudgetSplit", "SpendCapacity", "SpendBreakdown",
                                              "TopologyScreen", "SpendPhone"]},
    "TriggersScreen": (PLANNED, "#750. Its Watch and Dispatchers tabs are planned and proposed elsewhere."),
    "TriggerDetail": (BUILT, "Built by #767 (#750)."), "TriggerEditor": (BUILT, "Built by #767 (#750)."), "ConfigScreen": (BUILT, "Built by #767 (#750)."),
    **{n: (PLANNED, "#751.") for n in ["SecretsScreen", "ConnectionsScreen", "ProjectDetail"]},
    **{n: (BUILT, "In main since #742.") for n in ["SignIn", "AccessStates", "AuditScreen", "ErrorPage"]},
    "ApprovalRequest": (BUILT, "Built by #649: budget raises are worker-enforced; external gates are advisory. Model text stays in the transcript."), "ForkRun": (BUILT, "Built by #648, managed fork controls on the run page."),
    "ModelsScreen": (PLANNED, "#717 roles, #716 failover, #693 the Radius gateway."),
    "WatchScreen": (BUILT, "Built by #735: compact retained source, rule and finding view."), "WatchBoard": (BUILT, "Built by #743: retained trace, classifier totals and operator-adopted inert board; live projections remain future work."),
    "DispatchersScreen": (PROPOSED, "No issue yet; it grew out of #735."), "DispatcherScreen": (PROPOSED, "No issue yet; it grew out of #735."),
    "SandboxesScreen": (PROPOSED, "#753. The browser terminal part needs a decision first: #754."),
    "ZeroTouchScreen": (PROPOSED, "#753."), "ZeroTouchViewer": (PROPOSED, "#753. As a viewer sees it."),
    "ZeroTouchPhone": (PROPOSED, "#753. On a phone."),
    "ParkedDraftViewer": (PROPOSED, "#753. As a viewer sees it."), "ParkedDraftPhone": (PROPOSED, "#753. On a phone."),
    "RunLivePhone": (BUILT, "Built by #747, the run page on a phone."),
    "TriggersPhone": (PLANNED, "#750, on a phone."), "TriggersViewer": (PLANNED, "#750. As a viewer sees it."),
    "FleetPhone": (BUILT, "Built by #748, on a phone."), "FleetViewer": (BUILT, "Built by #748. As a viewer sees it."),
    "ParkedAnswerer": (PROPOSED, "#753. Sending with no person's confirm is not proposed: OQ-051."),
}
RIBBON_RE = re.compile(r'<div class="ds-status[^"]*" role="note"[^>]*>.*?</div>\n', re.S)
# The ribbon is a note on the card, not console styling, so its rules live here and are added to each card that
# carries one, never in components/bundle.css (which the console pastes as its own stylesheet).
RIBBON_CSS = """<style data-ds-status>
.ds-status { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; margin: var(--space-4) var(--space-6) 0; padding: 8px 14px; border-radius: var(--radius-md); border: 1.5px dashed var(--tone); background: var(--tone-tint); font-size: 13px; line-height: 18px; color: var(--ink); }
.ds-status__k { font-size: 11px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-muted); }
.ds-status__w { display: inline-flex; align-items: center; gap: 6px; font-weight: 750; color: var(--tone-ink); }
.ds-status__n { color: var(--ink-muted); min-width: 0; }
@media (max-width: 760px) { .ds-status { margin: 12px var(--space-4) 0; } }
</style>
"""
RIBBON_CSS_RE = re.compile(r"<style data-ds-status>.*?</style>\n", re.S)

def ribbon(name):
    st, note = STATUS[name]
    tone, glyph, word = WORD[st]
    return (f'<div class="ds-status tone-{tone}" role="note" aria-label="Design status: {word}">'
            f'<span class="ds-status__k">Design status</span>'
            f'<span class="ds-status__w"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-{glyph}"/></svg>{word}</span>'
            f'<span class="ds-status__n">{note}</span></div>\n')

def put_ribbon(name, text):
    text = RIBBON_CSS_RE.sub("", RIBBON_RE.sub("", text))
    if name not in STATUS or '<a class="skip"' not in text:
        return text
    text = text.replace("</head>", RIBBON_CSS + "</head>", 1)
    return text.replace('<a class="skip"', ribbon(name) + '<a class="skip"', 1)
found = sorted(d.name for d in ROOT.iterdir() if d.is_dir() and d.name != "Cover")
missing = [n for n in found if n not in WHERE]
assert not missing, f"cards without a group: {missing}"
unlabelled = [n for n in found if n not in STATUS and WHERE[n] not in ("Components", "Start here")]
assert not unlabelled, f"screen cards without a design status: {unlabelled}"

with sync_playwright() as p:
    b = p.chromium.launch()
    for name in found:
        src = ROOT / name / "preview.html"; t = put_ribbon(name, src.read_text()); src.write_text(t)
        m = re.match(r'<!-- @dsCard (.*?) -->', t); a = m.group(1)
        W = int(re.search(r'width=(\d+)', a).group(1))
        pg = b.new_page(viewport={"width": W, "height": 300})
        pg.goto(harness(src, 'dark').as_uri()); pg.wait_for_timeout(60)
        h = pg.evaluate("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)")
        pg.close()
        H = int((h + 9) // 10 * 10)
        a2 = re.sub(r'group="[^"]*"', f'group="{WHERE[name]}"', a)
        a2 = re.sub(r'height=\d+', f'height={H}', a2)
        src.write_text(t.replace(m.group(0), f"<!-- @dsCard {a2} -->", 1))
        print(f"{WHERE[name]:<18} {name:<22} {W}x{H}")
    b.close()
