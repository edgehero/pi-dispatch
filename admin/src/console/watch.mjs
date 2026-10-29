/** Watch summaries are public. Private evidence is read only for an explicit operator on this static page. */
import { publicWatchTrace } from "@edgehero/pi-dispatch/watch-trace";
import { WATCH_ID_RE as WATCH_RULE_ID_RE } from "@edgehero/pi-dispatch/watch-contract";
export { WATCH_RULE_ID_RE };
import { html } from "./html.mjs";
import { preText } from "./transcript.mjs";

export const WATCH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const rows = (value) => Array.isArray(value) ? value : [];
const count = (value) => { const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value; return Number.isSafeInteger(n) && n >= 0 ? n : 0; };
const link = (path, key, id, label = id) => html`<a class="link" href="${path}?${key}=${encodeURIComponent(id)}">${label}</a>`;

export function parseWatchQuery(params, { board = false, evidence = false } = {}) {
  const allowed = evidence ? ["finding"] : board ? ["rule", "finding"] : ["rule"];
  for (const key of params.keys()) if (!allowed.includes(key)) return { refusal: `watch takes only ${allowed.join(", ")}` };
  const query = {};
  for (const key of allowed) {
    const all = params.getAll(key);
    if (all.length > 1) return { refusal: `${key} is given more than once` };
    const value = all[0] ?? null;
    const shape = key === "rule" ? WATCH_RULE_ID_RE : WATCH_ID_RE;
    if (value !== null && !shape.test(value)) return { refusal: `${key} must be a watch identifier, at most ${key === "rule" ? 64 : 128} characters` };
    query[key] = value;
  }
  if (board && !query.rule) return { refusal: "the board needs a rule" };
  if (evidence && !query.finding) return { refusal: "the evidence needs a finding" };
  return { query: Object.freeze(query) };
}

export async function loadWatchData(store, query, { board = false, privateRead = false } = {}) {
  if (!store) return { unavailable: true };
  try {
    const rules = await store.listRules();
    const selectedRule = query.rule ?? rows(rules)[0]?.id ?? null;
    const findings = selectedRule ? await store.listFindings(selectedRule) : [];
    const out = { rules: rows(rules), findings: rows(findings), selectedRule, sources: typeof store.listSources === "function" ? await store.listSources() : [] };
    if (board) {
      const board = await store.readBoard(query.rule);
      out.board = privateRead ? board : publicBoardSummary(board);
      if (query.finding) {
        out.finding = await store.readFinding(query.finding, { private: privateRead });
        if (out.finding?.ruleId && out.finding.ruleId !== query.rule) throw new Error("finding belongs to another rule");
        const trace = await store.readTrace(query.finding, { private: privateRead });
        out.trace = privateRead ? trace : rows(trace).map(publicWatchTrace);
        if (!privateRead && out.finding) out.finding = Object.fromEntries(["id", "ruleId", "source", "fingerprint", "count", "severity", "status"].filter((key) => out.finding[key] !== undefined).map((key) => [key, out.finding[key]]));
      }
    }
    return out;
  } catch {
    return { unavailable: true };
  }
}

export function cooldownLeft(finding, rule, now) {
  if (!Number.isFinite(finding?.dueAt) || !Number.isFinite(rule?.cooldownMs) || !Number.isFinite(now)) return null;
  return Math.max(0, finding.dueAt + rule.cooldownMs - now);
}

export function sourceSummaries(data) {
  const sources = new Map(rows(data.sources).map((s) => [s.id, { ...s, lastDeliveryAt: null, capped: 0, suppressed: 0 }]));
  for (const rule of rows(data.rules)) {
    if (!sources.has(rule.source)) sources.set(rule.source, { id: rule.source, lastDeliveryAt: null, capped: 0, suppressed: 0 });
    const source = sources.get(rule.source);
    const at = count(rule.summary?.lastDeliveryAt);
    if (at > 0 && at <= 8.64e15) source.lastDeliveryAt = Math.max(source.lastDeliveryAt ?? 0, at);
    source.capped += count(rule.summary?.capped);
    source.suppressed += count(rule.summary?.suppressed);
  }
  return [...sources.values()];
}

export function decisionTotals(findings) {
  const models = new Map();
  for (const finding of rows(findings)) {
    const d = finding?.decision;
    if (!d || typeof d.model !== "string" || !/^[A-Za-z0-9_.:/@~-]{1,128}$/.test(d.model) || !["investigate", "file_issue", "ignore"].includes(d.action)) continue;
    if (!models.has(d.model)) models.set(d.model, { model: d.model, count: 0, costUsd: 0, unpriced: 0, investigate: 0, file_issue: 0, ignore: 0 });
    const model = models.get(d.model);
    model.count += 1; model[d.action] += 1;
    if (Number.isFinite(d.costUsd) && d.costUsd >= 0) model.costUsd += d.costUsd; else model.unpriced += 1;
  }
  return [...models.values()];
}

function decisionSummary(data) {
  const models = decisionTotals(data.findings);
  return html`<div class="card"><h2>Decision models</h2><p>Totals cover the loaded retained findings, at most 1,000.${rows(data.findings).length >= 1000 ? " This is a floor; older findings may be absent." : ""}</p>${models.length ? models.map((m) => html`<p class="tx__b">${m.model}: ${m.count} ${m.count === 1 ? "decision" : "decisions"}, known spend $${m.costUsd.toFixed(6)}${m.unpriced ? html` (${m.unpriced} without a recorded cost)` : null}; ${m.investigate} investigate, ${m.file_issue} file issue, ${m.ignore} ignore.</p>`) : html`<p>No retained decisions.</p>`}</div>`;
}

function findingRows(findings, rule, now, config) {
  return rows(findings).map((f) => html`<tr><td>${link("/watch/board", "rule", rule, f.id ?? f.fingerprint ?? "Finding")}</td><td>${f.severity ?? "unknown"}</td><td class="num">${count(f.count)}</td><td>${f.verdict ?? f.status ?? "unknown"}</td><td>${cooldownLeft(f, config, now) === null ? "Unknown" : `${Math.ceil(cooldownLeft(f, config, now) / 60000)}m`}</td><td>${f.runId ? link("/run", "id", f.runId) : "None"}</td></tr>`);
}

export function watchPanel(view) {
  const data = view.data?.watch;
  if (data?.unavailable || !data) return html`<div class="card"><h2>Watch unavailable</h2><p>The watch store could not be read. This is not an empty list.</p></div>`;
  const rules = rows(data.rules);
  return html`<div class="stack"><div class="card"><h2>Sources</h2>${sourceSummaries(data).length ? html`<ul>${sourceSummaries(data).map((source) => html`<li class="tx__b">${source.id}: ${source.verify ?? "signature check"}${Number.isSafeInteger(source.maxPerDay) ? html`, daily cap ${source.maxPerDay}` : null}; last delivery ${source.lastDeliveryAt ? new Date(source.lastDeliveryAt).toISOString() : "unknown"}; ${source.suppressed} suppressed, ${source.capped} capped. Credential health is unknown here; doctor checks on the receiver host.</li>`)}</ul>` : html`<p>No source status is available. Doctor checks source credentials.</p>`}</div><div class="card"><div class="card__head"><h2>Watch rules</h2></div><p>Sources and rules are written by hand in triggers.json. Findings cannot choose a job's permissions.</p>${rules.length ? html`<ul>${rules.map((r) => html`<li class="tx__b">${link("/watch/board", "rule", r.id)}: ${r.source ?? "unknown source"}${Number.isSafeInteger(r.maxPerDay) ? html`, at most ${r.maxPerDay} findings per day` : null}${r.flow ? html`, flow ${r.flow}` : null}${r.mode ? html`, ${r.mode}` : null}${["closed", "active", "uncertain", "suppressed"].includes(r.summary?.lastIssueStatus) ? html`; issue ${r.summary.lastIssueStatus}${["watch-issue-close-uncertain", "watch-issue-close-raced", "watch-issue-close-policy-changed"].includes(r.summary?.lastIssueReason) ? html` (${r.summary.lastIssueReason})` : null}` : null}</li>`)}</ul>` : html`<p>No watch rules have received findings.</p>`}</div><div class="card"><h2>Findings${data.selectedRule ? html` for ${data.selectedRule}` : null}</h2>${rows(data.findings).length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Finding</th><th>Severity</th><th>Count</th><th>Outcome</th><th>Cooldown</th><th>Job</th></tr></thead><tbody>${findingRows(data.findings, data.selectedRule ?? view.query?.rule, view.now, rows(data.rules).find((r) => r.id === (data.selectedRule ?? view.query?.rule)))}</tbody></table></div>` : html`<p>No retained findings for this rule.</p>`}</div></div>`;
}

/** Agent-authored values can be sensitive even when numeric; viewers get structural counts only. */
export function publicBoardSummary(board) {
  return { version: count(board?.version), frozen: board?.frozen === true, blockCount: Array.isArray(board?.blocks) ? board.blocks.length : count(board?.blockCount), proposalCount: Array.isArray(board?.proposals) ? board.proposals.length : count(board?.proposalCount), versionCount: Array.isArray(board?.versions) ? board.versions.length : count(board?.versionCount) };
}

function boardLineChart(block) {
  const points = rows(block.points).filter((p) => typeof p?.y === "number" && Number.isFinite(p.y));
  if (!points.length) return html`<p>No points.</p>`;
  const min = Math.min(...points.map((p) => p.y));
  const span = Math.max(...points.map((p) => p.y)) - min || 1;
  const line = points.map((p, i) => `${10 + i * 280 / Math.max(1, points.length - 1)},${90 - (p.y - min) * 80 / span}`).join(" ");
  return html`<svg width="100%" viewBox="0 0 300 100" role="img" aria-label="${block.title ?? "Query result"}"><polyline fill="none" stroke="currentColor" points="${line}"></polyline></svg><details><summary>Chart values</summary><table class="tbl"><thead><tr><th>Time</th><th>Value</th></tr></thead><tbody>${points.map((p) => html`<tr><td>${p.x}</td><td>${p.y}</td></tr>`)}</tbody></table></details>`;
}

function operatorBoardBlocks(board) {
  return rows(board?.blocks).map((b) => html`<article class="tx__b"><h3>${b.title ?? b.type}</h3>${b.type === "number" ? html`<p>${b.value} ${b.unit ?? ""}</p>` : b.type === "note" ? html`<p>${b.text}</p>` : b.type === "table" ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr>${rows(b.columns).map((v) => html`<th>${v}</th>`)}</tr></thead><tbody>${rows(b.rows).map((r) => html`<tr>${rows(r).map((v) => html`<td>${v}</td>`)}</tr>`)}</tbody></table></div>` : b.type === "line" ? boardLineChart(b) : b.type === "hypotheses" ? html`<ul>${rows(b.items).map((v) => html`<li>${v}</li>`)}</ul>` : b.type === "timeline" ? html`<ol>${rows(b.items).map((v) => html`<li>${v.at}: ${v.text}</li>`)}</ol>` : null}<p class="muted">Trace ${b.traceId}</p></article>`);
}

function boardControls(view, board) {
  if (view.role !== "operator" || view.readOnly || !board) return null;
  const form = (action, label, version, proposalId) => html`<form class="act" data-action="${action}"><input type="hidden" name="rule" value="${view.query.rule}"><input type="hidden" name="expectedVersion" value="${board.version}">${version !== undefined ? html`<input type="hidden" name="version" value="${version}">` : null}${proposalId ? html`<input type="hidden" name="proposalId" value="${proposalId}">` : null}<button class="btn btn--sm" type="submit">${label}</button></form>`;
  return html`<div>${form(board.frozen ? "board-unfreeze" : "board-freeze", board.frozen ? "Unfreeze" : "Freeze")}${form("board-clear", "Clear")}${!board.frozen ? rows(board.proposals).map((p) => html`<details class="tx__b"><summary>Proposal ${p.id}</summary>${operatorBoardBlocks(p)}${form("board-adopt", "Preview adoption", undefined, p.id)}</details>`) : null}${rows(board.versions).filter((v) => v.version !== board.version).map((v) => form("board-revert", `Restore version ${v.version}`, v.version))}</div>`;
}

function privateTrace(data) {
  const json = (value) => { try { return JSON.stringify(value, null, 2); } catch { return "This entry could not be read."; } };
  return html`<div class="tx__b"><h3>Samples</h3>${rows(data.finding?.samples).map((sample) => html`<pre>${preText(typeof sample === "string" ? sample : json(sample))}</pre>`)}${rows(data.trace).map((entry) => html`<details><summary>${publicWatchTrace(entry).kind ?? "entry"}: ${publicWatchTrace(entry).status ?? publicWatchTrace(entry).action ?? "recorded"}</summary>${["query", "state", "questions", "answers", "usage", "usedFor"].filter((key) => entry[key] !== undefined).map((key) => html`<h4>${key}</h4><pre>${preText(typeof entry[key] === "string" ? entry[key] : json(entry[key]))}</pre>`)}</details>`)}</div>`;
}

function publicTrace(entries) {
  return rows(entries).map(publicWatchTrace).map((e) => html`<li class="tx__b">${e.kind ?? "unknown"}: ${e.status ?? "recorded"}${e.action ? html`; chose ${e.action}` : null}${e.model ? html`; model ${e.model}` : null}${typeof e.costUsd === "number" ? html`; cost $${e.costUsd.toFixed(6)}` : null}${Number.isSafeInteger(e.at) && e.at <= 8.64e15 ? html`; ${new Date(e.at).toISOString()}` : null}${Number.isSafeInteger(e.rows) ? html`; ${e.rows} rows` : null}${e.source ? html` source ${e.source}` : null}${e.signature ? html` signature ${e.signature}` : null}${Number.isSafeInteger(e.count) ? html` ${e.count} events` : null}${e.checks ? Object.entries(e.checks).map(([key, value]) => html`<span> ${key}: ${value} </span>`) : null}${typeof e.confidence === "number" ? html`, confidence ${e.confidence}` : null}${e.probabilities ? Object.entries(e.probabilities).map(([key, value]) => html`<span> ${key}: ${value} </span>`) : null}</li>`);
}

export function watchBoardPanel(view) {
  const data = view.data?.watch;
  if (data?.unavailable || !data) return html`<div class="card"><h2>Board unavailable</h2><p>The watch store could not be read. Try again.</p></div>`;
  const board = data.board;
  const summary = publicBoardSummary(board);
  return html`<div class="stack"><div class="card"><h2 class="tx__b">Rule ${view.query?.rule}</h2><p>${link("/watch", "rule", view.query?.rule, "All findings")}</p><p>A person approves code changes. Each finding runs in a fresh bounded job.</p></div><div class="card"><h2>Board</h2><p>Version ${count(board?.version)}${board?.frozen ? ", frozen" : ""}</p>${view.role === "operator" ? operatorBoardBlocks(board) : html`<p>Board blocks: ${summary.blockCount}; proposals: ${summary.proposalCount}; retained versions: ${summary.versionCount}.</p>`}${summary.blockCount === 0 ? html`<p>No adopted board yet.</p>` : null}${boardControls(view, board)}</div><div class="card"><h2>Finding history</h2>${rows(data.findings).map((f) => html`<p><a class="link" href="/watch/board?rule=${encodeURIComponent(view.query?.rule ?? "")}&amp;finding=${encodeURIComponent(f.id ?? "")}">${f.id}</a>: ${f.verdict ?? f.status ?? "unknown"}, ${count(f.count)} events</p>`)}</div>${decisionSummary(data)}${view.query?.finding ? html`<div class="card"><h2>Evidence and trace</h2><ol>${publicTrace(data.trace)}</ol>${view.role === "operator" ? html`${privateTrace(data)}<p>${link("/api/watch-trace", "finding", view.query.finding, "Download private evidence as JSON")}</p>` : html`<p>Samples, query text, decision state and notes are shown to operators only.</p>`}</div>` : null}</div>`;
}

export async function getWatchTrace(ctx) {
  const parsed = parseWatchQuery(ctx.searchParams, { evidence: true });
  if (parsed.refusal) return ctx.json(400, { error: parsed.refusal });
  const store = ctx.deps.pageDeps?.watch;
  if (!store) return ctx.json(503, { error: "the watch store is unavailable" });
  try {
    const finding = await store.readFinding(parsed.query.finding, { private: true });
    if (!finding) return ctx.json(404, { error: "the finding is not retained" });
    const trace = await store.readTrace(parsed.query.finding, { private: true });
    return ctx.json(200, { finding, trace });
  } catch {
    return ctx.json(503, { error: "the watch store could not be read" });
  }
}
