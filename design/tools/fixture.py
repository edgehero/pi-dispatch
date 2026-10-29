"""The sample deployment every card draws: one day at acme, as one source.

Every name, id and time a card shows should come from here, or at least agree with it. `check_fixture.py` scans the
built cards and names every run drawn with a target, host or venue that disagrees with this file.

The day is Thursday 8 October 2026 and the time is 15:39 UTC, so a card's dates stay in the past (Zero touch's fixes are
24 and 29 September for that reason). The deployment is the repo's own `launch/fixture-deployment.mjs` shape: three
hosts, four projects and seven triggers, plus the planned screens' additions marked `planned`.
"""

DAY = "Thursday 8 October 2026"
NOW = "15:39"            # UTC, the "now" line on every timeline

PEOPLE = {
    "ops": "operator token: every write, every action",
    "watcher": "viewer token: numbers, states and tool names only",
}

# host: (venues it runs, its default venue first; what it is)
HOSTS = {
    "mini1": (["local"], "Mac mini, 8 cores, 16 GiB, the console's own host"),
    "mini2": (["local", "openshell", "openshell-bind"], "Mac mini with an OpenShell gateway"),
    "build3": (["podman"], "Linux build box, 12 cores, 24 GiB, rootless Podman"),
}

# project: its members (repositories and local folders)
PROJECTS = {
    "web": ["acme/web"],
    "api": ["acme/api", "acme/api-docs"],
    "billing": ["acme/billing", "acme/billing-ui", "local:billing-jobs"],
    "ops": ["local:site", "local:pm"],
    "shop": [],          # watch jobs only (Watch, #735)
}

# number: (kind, when, flow)
TRIGGERS = {
    1: ("cron", "every day at 03:00 UTC, folder site on mini1", "tidy"),
    2: ("label", "pi:frontend added to an issue", "frontend-fix"),
    3: ("comment", '"@pi" in a comment, keeps a session, has instructions', "fix"),
    4: ("pull_request", "a merge request is opened or updated (GitLab)", "review"),
    5: ("issue", "issue #40 is closed, once", "release-notes"),
    6: ("cron", "every Monday at 06:00 UTC, folder pm on mini1", "weekly-report"),
    7: ("label", "pi:triage added to an issue; two replicas, recovery armed", "triage"),
    11: ("answer", "planned: a run of api or web parks (an answer rule, #753)", "draft-answer"),
}

# The runs of the day, as the Runs card lists them: id -> (ended, target, flow, host, venue, outcome)
# GitLab merge requests are written project!iid, as the run record writes them.
RUNS = {
    "gh-e9a0": ("15:30", "acme/billing#260", "fix", "build3", "podman", "refused"),
    "gh-a91e": ("15:25", "acme/web#422", "fix", "mini2", "openshell", "completed"),
    "gh-2f6a": ("15:13", "acme/api#131", "triage", "mini1", "local", "awaiting"),
    "gh-9575": ("15:12", "acme/web#490", "fix", "mini1", "local", "completed"),
    "gh-f0c2": ("15:10", "acme/web#491", "fix", "mini1", "local", "failed"),
    "gh-ebd7": ("14:48", "acme/billing#259", "fix", "build3", "podman", "completed"),
    "gh-4add": ("14:39", "acme/web#489", "fix", "mini1", "local", "completed"),
    "gh-a3ac": ("14:34", "acme/web#487", "fix", "mini1", "local", "completed"),
    "gh-8251-r2": ("14:17", "acme/web#408", "frontend-fix", "mini2", "local", "completed"),
    "gh-bd09": ("14:09", "acme/web#488", "fix", "mini1", "local", "completed"),
    "gh-e12d": ("14:06", "acme/web#486", "fix", "mini1", "local", "completed"),
    "gh-8251-r1": ("13:55", "acme/web#408", "frontend-fix", "mini1", "local", "completed"),
    "gl-9a2c": ("13:49", "acme/billing-ui!405", "review", "mini2", "local", "completed"),
    "gh-03a9": ("12:43", "acme/api#122", "fix", "mini2", "local", "completed"),
    "gh-7cdf": ("12:39", "acme/billing#258", "fix", "build3", "podman", "completed"),
    "gh-98f4": ("12:23", "acme/web#657", "fix", "mini1", "local", "completed"),
    "gh-985d": ("11:05", "acme/api#121", "fix", "mini1", "local", "completed"),
    "gh-4a7e": ("10:59", "acme/billing#290", "fix", "build3", "podman", "cancelled"),
    "gl-021a": ("10:44", "acme/billing-ui!404", "review", "mini2", "local", "completed"),
    "gh-7813": ("10:43", "acme/billing#257", "fix", "build3", "podman", "completed"),
    "gh-444c": ("09:45", "acme/api#120", "fix", "mini2", "local", "completed"),
    "gh-52a8": ("09:29", "acme/billing#256", "fix", "build3", "podman", "completed"),
    "gh-b0bd": ("08:58", "acme/web#656", "fix", "mini1", "local", "completed"),
    "gl-af91": ("yesterday", "acme/billing-ui!403", "review", "mini2", "local", "completed"),
    "gh-476b": ("yesterday", "acme/billing#254", "fix", "build3", "podman", "completed"),
    "gh-c3f8": ("yesterday", "acme/billing#253", "fix", "build3", "podman", "completed"),
}

# Runs that are not in the ended list: running, waiting, or drawn by one planned screen.
OTHER_RUNS = {
    "gh-b3d7": ("running", "acme/web#415", "fix", "mini1", "local", "running"),
    "gh-c41f": ("running", None, None, "mini1", "local", "running"),
    "gh-e802": ("running", None, None, "build3", "podman", "running"),
    "gh-77c1": ("waiting", "acme/web#415", "fix", None, None, "held"),
    "gh-6e21": ("waiting", "acme/web#418", None, None, None, "delayed"),
    "gh-5d10": ("recovering", None, None, None, None, "running"),
    "gh-91a0": ("waiting", "acme/api#140", None, None, None, "held"),
    "gh-6e1d": ("15:35", "acme/web#512", "fix", "mini2", "local", "awaiting"),   # planned: ParkedAnswerer
    "gh-5a02": ("14:31", "acme/web#498", "fix", None, None, "completed"),        # planned: ParkedAnswerer
    "sb-3c1f": ("open", "acme/web", None, "mini1", "local", "sandbox"),          # proposed: SandboxesScreen
    "gh-0c4e": (None, None, None, None, None, None),     # first drawn on ApprovalRequest; fill in when a second card draws it
    "gh-38aa": (None, None, None, None, None, None),     # first drawn on OverviewScreen; fill in when a second card draws it
    "gh-3c90": (None, None, None, None, None, None),     # first drawn on ApprovalRequest; fill in when a second card draws it
    "gh-3e71": (None, None, None, None, None, None),     # first drawn on RunChatStates; fill in when a second card draws it
    "gh-40a1": (None, None, None, None, None, None),     # first drawn on TriggersScreen; fill in when a second card draws it
    "gh-55d2": (None, None, None, None, None, None),     # first drawn on ApprovalRequest; fill in when a second card draws it
    "gh-5d10-r1": (None, None, None, None, None, None),  # first drawn on RunRecovered; fill in when a second card draws it
    "gh-5d10-r2": (None, None, None, None, None, None),  # first drawn on RunRecovered; fill in when a second card draws it
    "gh-71aa": (None, None, None, None, None, None),     # first drawn on ApprovalRequest; fill in when a second card draws it
    "gh-71b2": (None, None, None, None, None, None),     # first drawn on OverviewScreen; fill in when a second card draws it
    "gh-77e0": (None, None, None, None, None, None),     # first drawn on RunChatStates; fill in when a second card draws it
    "gh-7b21": (None, None, None, None, None, None),     # first drawn on ApprovalRequest; fill in when a second card draws it
    "gh-81b2": (None, None, None, None, None, None),     # first drawn on RunChatStates; fill in when a second card draws it
    "gh-91d2": (None, None, None, None, None, None),     # first drawn on HostDetail; fill in when a second card draws it
    "gh-91d4": (None, None, None, None, None, None),     # first drawn on ParkedAnswerer; fill in when a second card draws it
    "gh-9d14": (None, None, None, None, None, None),     # first drawn on ConfirmStates; fill in when a second card draws it
    "gh-a07c": (None, None, None, None, None, None),     # first drawn on ParkedAnswerer; fill in when a second card draws it
    "gh-c9e1": (None, None, None, None, None, None),     # first drawn on TriggerDetail; fill in when a second card draws it
}

PARKED_QUESTION = "Should the export rate limit apply per API key or per account? The issue mentions both."


def run(job_id):
    """The fixture's row for a run id, or None."""
    return RUNS.get(job_id) or OTHER_RUNS.get(job_id)
