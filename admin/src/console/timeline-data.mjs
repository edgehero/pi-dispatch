import { collect } from "./timeline.mjs";
import { outcomeWord } from "../words.mjs";
import { scrubControls } from "../panel.mjs";

const text = (value) => typeof value === "string" ? scrubControls(value) : null;
export const timelineKey = (r) => JSON.stringify([r.jobId, r.host ?? null]);
export function timelineHref(r) {
  return "/run?id=" + encodeURIComponent(r.jobId) + (r.host ? "&historyHost=" + encodeURIComponent(r.host) : "");
}

/** A closed data projection for the library. User text is always inserted as DOM text, never a template string. */
export function timelineRecord(r) {
  const state = outcomeWord(r.outcome, r.reason);
  return {
    id: timelineKey(r), jobId: r.jobId, host: r.host, project: r.project, target: text(r.target),
    start: r.startedAt ?? r.endedAt, end: r.endedAt ?? r.startedAt,
    startedAt: r.startedAt, endedAt: r.endedAt, href: timelineHref(r),
    kind: state.status === "ok" || state.status === "cancelled" ? "ok" : state.status === "parked" ? "parked" : state.status === "refused" ? "refused" : "failed",
    word: ["awaiting-input", "awaiting-approval"].includes(r.reason) ? "requested " + (r.reason === "awaiting-input" ? "input" : "approval") : state.word ?? "outcome unknown",
  };
}

export function timelineSeed({ now, start, runs, active, hostJobs, waiting, parked }) {
  const items = collect({ now, start, recorded: false, runs, active, hostJobs, waiting, parked });
  const records = new Map((Array.isArray(runs) ? runs : runs?.runs ?? []).map(r => [timelineKey(r), r]));
  const instant = value => value == null ? null : Number.isFinite(Number(value)) ? Number(value) : Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  // Preserve live work if the initial snapshot is full; retained completed runs are also available through the API.
  items.sort((a, b) => Number(["ok", "failed", "refused"].includes(a.kind)) - Number(["ok", "failed", "refused"].includes(b.kind)));
  return items.slice(0, 2000).map((r) => {
    const record = records.get(timelineKey(r));
    const running = active?.find(a => a.jobId === r.jobId);
    const registered = hostJobs?.find(h => h.name === r.host)?.jobs?.find(j => j.id === r.jobId);
    return {
      id: timelineKey(r), jobId: r.jobId, host: r.host, project: r.project, target: text(r.target), href: timelineHref(r),
      start: r.startAt, end: r.endAt,
      startedAt: r.kind === "wait" ? null : instant(record?.startedAt ?? running?.startedAt ?? registered?.at),
      endedAt: ["wait", "run", "held"].includes(r.kind) ? null : instant(record?.endedAt),
      kind: r.kind, word: text(r.kind === "wait" ? r.why ?? r.word : r.kind === "held" ? "slot held" : r.word),
    };
  });
}
