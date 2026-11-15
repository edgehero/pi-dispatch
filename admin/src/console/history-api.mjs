import { randomBytes } from "node:crypto";
import { HISTORY_CURSOR_TTL_MS, HISTORY_CURSORS_MAX, HISTORY_TOKEN_RE, historyRow } from "@edgehero/pi-dispatch/history-reader";
import { TIMELINE_DEFAULTS, TIMELINE_ROWS, TIMELINE_ZOOMS } from "./timeline.mjs";
import { historyPageHtml } from "./history-view.mjs";
import { agentReadProjection } from "../agent-read.mjs";
import { timelineRecord } from "./timeline-data.mjs";

export function parseHistoryQuery(params, now) {
  if (params.get("format") === "data") {
    if ([...params.keys()].some((k) => !["format", "start", "end", "project", "cursor"].includes(k) || params.getAll(k).length !== 1)) return null;
    const integer = (key) => /^\d{1,16}$/.test(params.get(key) ?? "") ? Number(params.get(key)) : NaN;
    const start = integer("start"), end = integer("end"), project = params.get("project") || null, cursor = params.get("cursor");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 7 * 86400000 || end > now + 7 * 86400000 || project !== null && !/^[a-z][a-z0-9-]{0,31}$/.test(project) || cursor !== null && !HISTORY_TOKEN_RE.test(cursor)) return null;
    return { format: "data", start, end, project, cursor };
  }
  const allowed = ["rows", "zoom", "project", "anchor", "cursor"];
  if ([...params.keys()].some((k) => !allowed.includes(k) || params.getAll(k).length !== 1)) return null;
  const rows = params.get("rows") || TIMELINE_DEFAULTS.rows;
  const zoom = params.get("zoom") || TIMELINE_DEFAULTS.zoom;
  const project = params.get("project") || null;
  const raw = params.get("anchor");
  const anchor = raw === null ? now : /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  const cursor = params.get("cursor");
  if (!TIMELINE_ROWS.includes(rows) || !Object.hasOwn(TIMELINE_ZOOMS, zoom) || project !== null && !/^[a-z][a-z0-9-]{0,31}$/.test(project) || !Number.isSafeInteger(anchor) || anchor < TIMELINE_ZOOMS[zoom].pastMs || anchor > now + 60_000 || cursor !== null && !HISTORY_TOKEN_RE.test(cursor)) return null;
  return { rows, zoom, project, anchor, cursor };
}

// Continuations bind the source list and the range once. Changes to the live registry cannot shift a cursor past a host.
// The map holds only cursors and coverage, never an archive or browser-supplied HTML.
export function makeTimelineReader({ fleet, now = () => Date.now(), random = () => randomBytes(16).toString("hex") }) {
  const cursors = new Map();
  let opening = 0;
  return async function read(q, person) {
    for (const [key, c] of cursors) if (!c.busy && now() - c.at >= HISTORY_CURSOR_TTL_MS) cursors.delete(key);
    const query = { start: q.start ?? q.anchor - TIMELINE_ZOOMS[q.zoom].pastMs, end: q.end ?? q.anchor + TIMELINE_ZOOMS[q.zoom].futureMs, project: q.project };
    const signature = JSON.stringify(query);
    let id = q.cursor, c = id ? cursors.get(id) : null;
    if (id && (!c || c.person !== person || c.signature !== signature)) return { error: "cursor-expired", runs: [], next: null, partial: true, olderAt: null };
    if (!c && cursors.size + opening >= HISTORY_CURSORS_MAX) {
      const idle = [...cursors.entries()].filter(([, value]) => !value.busy).sort((a, b) => a[1].at - b[1].at)[0];
      if (idle) cursors.delete(idle[0]);
    }
    if (c?.busy || !c && cursors.size + opening >= HISTORY_CURSORS_MAX) return { error: "history-busy", runs: [], next: null, partial: true, olderAt: null };
    if (!c) {
      let sources;
      opening++;
      try { sources = await fleet.historySources(); } finally { opening--; }
      id = random();
      c = { signature, person, hosts: [null, ...(sources.hosts ?? []), "@mirror"], readHosts: [], unavailable: [], source: 0, cursor: null, partial: Boolean(sources.partial), olderAt: null, at: now() };
      cursors.set(id, c);
    }
    c.busy = true;
    try {
      const got = await fleet.historyPage({ query, cursor: c.cursor, host: c.hosts[c.source], excludeHosts: c.readHosts });
      if (got.error) c.unavailable.push(c.hosts[c.source] ?? "local");
      c.partial ||= Boolean(got.error || got.partial || !Array.isArray(got.runs) || got.runs.length > 100 || got.next != null && !HISTORY_TOKEN_RE.test(got.next));
      if (!got.error && c.hosts[c.source] !== "@mirror") for (const r of Array.isArray(got.runs) ? got.runs : []) if (typeof r?.host === "string" && r.host.length <= 253 && !c.readHosts.includes(r.host)) c.readHosts.push(r.host);
      if (Number.isFinite(got.olderAt)) c.olderAt = Math.max(c.olderAt ?? 0, got.olderAt);
      c.cursor = typeof got.next === "string" && HISTORY_TOKEN_RE.test(got.next) ? got.next : null;
      if (!c.cursor) c.source++;
      const done = c.source >= c.hosts.length;
      if (done) cursors.delete(id);
      // Rebuild every remote row as rigorously as a local row. Times on this internal wire are milliseconds.
      const runs = (Array.isArray(got.runs) ? got.runs : []).slice(0, 100).map((r) => historyRow({ ...r, startedAt: Number.isSafeInteger(r?.startedAt) && r.startedAt >= 0 && r.startedAt <= 253402300799999 ? new Date(r.startedAt).toISOString() : null, endedAt: Number.isSafeInteger(r?.endedAt) && r.endedAt >= 0 && r.endedAt <= 253402300799999 ? new Date(r.endedAt).toISOString() : null })).filter((r) => r && (query.project === null || r.project === query.project) && (r.startedAt ?? r.endedAt) < query.end && (r.endedAt ?? r.startedAt) >= query.start);
      if (runs.length !== (got.runs?.length ?? 0)) c.partial = true;
      return { runs, next: done ? null : id, partial: c.partial, olderAt: c.olderAt, unavailable: c.unavailable };
    } finally { c.busy = false; c.at = now(); }
  };
}

const readers = new WeakMap();
export async function getTimeline(ctx) {
  const fleet = ctx.deps.pageDeps?.fleet;
  const now = ctx.deps.now();
  const q = parseHistoryQuery(ctx.searchParams, now);
  if (!q) return ctx.json(400, { error: "Choose a valid history window, project and cursor." });
  if (!fleet?.historyPage || !fleet?.historySources) return ctx.json(503, { error: "Run history is not available in this console." });
  if (!readers.has(fleet)) readers.set(fleet, makeTimelineReader({ fleet, now: ctx.deps.now }));
  let page;
  try { page = await readers.get(fleet)(q, `${ctx.session.name}.${ctx.session.role}`); }
  catch { return ctx.json(503, { error: "Run history could not be read. Try again." }); }
  const failed = Boolean(page.error);
  if (ctx.session.role === "agent") page = { ...agentReadProjection(page), ...(failed ? { error: true } : {}) };
  if (q.format === "data") return ctx.json(failed ? 409 : 200, {
    items: page.runs.map(timelineRecord), next: page.next, partial: page.partial,
    olderAt: page.olderAt, unavailable: page.unavailable ?? [],
    ...(failed ? { error: "History continuation expired or is busy. Retry this range." } : {}),
  });
  const runHref = (id) => { const host = page.runs.find((r) => r.jobId === id)?.host; return "/run?id=" + encodeURIComponent(id) + (host ? "&historyHost=" + encodeURIComponent(host) : ""); };
  return ctx.json(failed ? 409 : 200, { html: String(historyPageHtml({ query: q, now, page, runHref })), next: page.next, count: page.runs.length, partial: page.partial });
}
