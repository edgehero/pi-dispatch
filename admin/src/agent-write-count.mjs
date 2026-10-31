/** Count this host's applied agent-write receipts, never the bounded fleet mirror or pre-write intentions. */
export const AGENT_WRITE_SCAN_MAX = 10000;

export async function readAgentWritesToday({ read, verify, now = Date.now, host = null, maxRows = AGENT_WRITE_SCAN_MAX } = {}) {
  const instant = typeof now === "function" ? now() : now;
  const since = Date.parse(`${new Date(instant).toISOString().slice(0, 10)}T00:00:00Z`);
  const base = { host, since, until: instant, scope: "local-console", count: null, partial: true, unavailable: false };
  let chain;
  try { chain = await verify(); }
  catch { return { ...base, unavailable: true }; }
  if (!chain?.ok) return { ...base, unavailable: true };
  const rows = [];
  let before = null, complete = false, examined = 0, newestSeq = null;
  try {
    while (examined < maxRows) {
      const page = await read({ before, limit: Math.min(500, maxRows - examined), positions: true });
      if (page?.unreadable || !Array.isArray(page?.rows)) return { ...base, unavailable: true };
      if (page.rows.some(row => row?.broken)) return { ...base, unavailable: true };
      if (newestSeq === null && page.rows.length) newestSeq = page.rows[0].seq;
      examined += page.rows.length;
      for (const row of page.rows) {
        const at = typeof row?.at === "number" ? row.at : Date.parse(row?.at ?? "");
        if (!Number.isFinite(at)) return { ...base, unavailable: true };
        if (at >= since && at <= instant && row.actor?.role === "agent") rows.push(row);
      }
      // Chain sequence is monotonic; wall-clock timestamps need not be. A clock adjustment can put
      // today's receipt behind an older timestamp, so only an exhausted bounded read proves coverage.
      if (!page.next) { complete = true; break; }
      if (page.next === before || !page.rows.length) break;
      before = page.next;
    }
  } catch { return { ...base, unavailable: true }; }
  const key = row => `${row.ticket ?? `seq-${row.seq}`}:${row.kind ?? ""}:${row.target ?? ""}`;
  const failed = new Set(rows.filter(row => row.action === "write" && row.outcome !== "ok").map(key));
  const receipts = new Set(rows.filter(row => row.action === "write-applied" && row.outcome === "ok" && !failed.has(key(row))).map(key));
  const pending = rows.some(row => row.action === "write" && row.outcome === "ok" && !receipts.has(key(row)) && !failed.has(key(row)));
  const checkedSeq = chain.last?.seq ?? chain.rows ?? 0;
  return { ...base, count: receipts.size, examined, partial: !complete || chain.startsAt !== null && chain.startsAt !== undefined || pending || newestSeq !== null && newestSeq > checkedSeq };
}
