// The offset belongs to the supplied instant, including a repeated autumn hour, never to the current clock.
export function timelineLocalTime(ms, compact = false) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date(ms), off = -d.getTimezoneOffset(), abs = Math.abs(off);
  const zone = off === 0 ? "UTC" : "UTC" + (off < 0 ? "-" : "+") + Math.floor(abs / 60) + (abs % 60 ? ":" + pad(abs % 60) : "");
  const clock = pad(d.getHours()) + ":" + pad(d.getMinutes());
  return compact ? clock : d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + clock + " " + zone;
}

// This function is served as code by script.mjs. Keep it self-contained so the browser and tests execute one copy.
export function historyBrowser({ document, location, history, fetch, render, zooms, time, localTimes, personHeader, person, onAuth, now = () => Date.now() }) {
  const panel = document.getElementById("p-timeline");
  if (!panel) return null;
  let pinned = new URLSearchParams(location.search).has("anchor");
  let loading = false, generation = 0, controller = null;
  let pages = [], pageIndex = -1, touched = null;
  const query = () => new URLSearchParams(location.search);
  const frame = () => panel.querySelector("[data-history-frame]");
  const status = (text) => { const el = panel.querySelector("[data-history-status]"); if (el) el.textContent = text; };
  function preview(link) {
    const box = panel.querySelector("[data-history-preview]");
    if (!box) return;
    const start = Number(link.getAttribute("data-run-start")), end = Number(link.getAttribute("data-run-end"));
    const kind = link.getAttribute("data-run-kind"), ended = !["run", "held", "wait"].includes(kind);
    const lines = [link.getAttribute("aria-label"), link.getAttribute("data-run-id"), link.getAttribute("data-run-project") || "no project", link.getAttribute("data-run-target"), link.getAttribute("data-run-word")];
    if (Number.isFinite(start)) lines.push((kind === "wait" ? "Due or next check " : "Started ") + time(start));
    if (ended && link.getAttribute("data-run-end") && Number.isFinite(end)) lines.push("Ended " + time(end), "Duration " + Math.max(0, Math.round((end - start) / 1000)) + " seconds");
    box.textContent = lines.filter(Boolean).join(" · ");
    const open = document.createElement("a"); open.href = link.getAttribute("href"); open.className = "btn btn--sm"; open.textContent = "Open run"; box.appendChild(open);
    const close = document.createElement("button"); close.setAttribute("type", "button"); close.className = "btn btn--sm btn--ghost"; close.textContent = "Close preview";
    close.addEventListener("click", () => { link.focus({ preventScroll: true }); box.hidden = true; }); box.appendChild(close);
    box.hidden = false;
  }
  function init() {
    localTimes(panel);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
    const label = panel.querySelector("[data-history-zone]");
    if (label) label.textContent = zone + ". Times use the offset at each instant. Scroll sideways, or use Older and Newer.";
    const ticks = [...panel.querySelectorAll("[data-timeline-at]")];
    const counts = new Map();
    for (const t of ticks) { const word = time(Number(t.getAttribute("data-timeline-at")), true); counts.set(word, (counts.get(word) || 0) + 1); }
    for (const t of ticks) {
      const at = Number(t.getAttribute("data-timeline-at")), word = time(at, true);
      t.textContent = counts.get(word) > 1 ? time(at).split(" ").slice(1).join(" ") : word;
      t.setAttribute("aria-label", time(at));
    }
    for (const t of panel.querySelectorAll("[data-timeline-zone]")) t.textContent = "Local";
    for (const link of panel.querySelectorAll(".tl-run")) {
      const start = Number(link.getAttribute("data-run-start")), end = Number(link.getAttribute("data-run-end"));
      // The preview carries full dated instants and the pill keeps the same local clock as the axis.
      const instants = JSON.parse(link.getAttribute("data-run-times") || "[]");
      const replacements = instants.filter(Number.isFinite).map((at) => [new Date(at).toISOString().slice(11, 16), time(at, true)]);
      for (const t of link.querySelectorAll("text, tspan")) {
        for (const child of t.childNodes) if (child.nodeType === 3) {
          const original = child._historyUtc ?? child.textContent;
          child._historyUtc = original;
          child.textContent = original.replace(/\b\d{2}:\d{2}\b/g, (clock) => replacements.find((r) => r[0] === clock)?.[1] ?? clock);
        }
      }
      const base = link.getAttribute("data-run-title") || "";
      const dated = instants.map((at) => {
        const iso = new Date(at).toISOString();
        const sameDay = iso.slice(0, 10) === new Date(Number(link.getAttribute("data-run-now"))).toISOString().slice(0, 10);
        return [sameDay ? iso.slice(11, 16) : iso.slice(0, 16).replace("T", " "), time(at)];
      });
      const title = base.replace(/(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}(?: UTC)?/g, (clock) => dated.find((r) => r[0] === clock.replace(/ UTC$/, ""))?.[1] ?? clock);

      link.setAttribute("aria-label", title);
      for (const t of link.querySelectorAll("title")) t.textContent = title;
    }
    const scroll = panel.querySelector(".history-window");
    if (scroll && !scroll._historyReady) {
      scroll._historyReady = true;
      scroll.scrollLeft = 80;
      const cap = panel.querySelector(".tnowcap"), head = panel.querySelector(".tl__h");
      if (cap?.getBoundingClientRect && head?.getBoundingClientRect) {
        const box = scroll.getBoundingClientRect(), mark = cap.getBoundingClientRect(), width = head.getBoundingClientRect().width;
        scroll.scrollLeft += mark.left + mark.width / 2 - box.left - (width + Math.max(0, box.width - width) * 0.6);
      }
      let armed = false;
      scroll.addEventListener("pointerdown", () => { armed = true; });
      scroll.addEventListener("wheel", () => { armed = true; }, { passive: true });
      scroll.addEventListener("keydown", (e) => {
        if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); move(-1); }
        if (["ArrowRight", "PageDown"].includes(e.key)) { e.preventDefault(); move(1); }
        if (e.key === "End") { e.preventDefault(); navigate("/"); }
      });
      scroll.addEventListener("scroll", () => {
        if (!armed || loading) return;
        const max = scroll.scrollWidth - scroll.clientWidth;
        if (scroll.scrollLeft <= 2) { armed = false; move(-1); }
        else if (max > 0 && scroll.scrollLeft >= max - 2) { armed = false; move(1); }
      }, { passive: true });
    }
  }
  function move(direction) {
    const f = frame(); if (!f) return;
    const p = query(), span = zooms[f.getAttribute("data-history-zoom")].pastMs;
    p.set("anchor", String(Math.max(span, Math.min(now(), Number(f.getAttribute("data-history-anchor")) + direction * span))));
    navigate("/?" + p);
  }
  async function load(cursor = null, resetScroll = false) {
    if (loading) return;
    const p = query(), f = frame();
    if (!p.has("anchor")) p.set("anchor", f?.getAttribute("data-history-anchor") || String(now()));
    const anchor = p.get("anchor");
    if (cursor) p.set("cursor", cursor);
    const mine = ++generation;
    pinned = true; loading = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 12000);
    status("Reading retained run history…");
    try {
      const headers = {}; if (person) headers[personHeader] = person;
      const res = await fetch("/api/timeline?" + p, { credentials: "same-origin", headers, signal: controller.signal });
      if (res.status === 401 || res.status === 403) { onAuth(); return; }
      const result = await res.json();
      if (mine !== generation) return;
      if (!res.ok) throw new Error(result.error || "History could not be read. Read this window again.");
      // A new window must open away from an edge so the next wheel/touch gesture can scroll to that edge again.
      const keep = resetScroll ? null : panel.querySelector(".history-window")?.scrollLeft ?? 80;
      const focused = panel.contains(document.activeElement);
      render(result.html);
      init();
      const scroll = panel.querySelector(".history-window"); if (scroll && keep !== null) scroll.scrollLeft = keep;
      if (focused) panel.querySelector("[data-history-load], [data-history-restart]")?.focus({ preventScroll: true });
      const own = query(); own.set("anchor", anchor);
      history.replaceState(null, "", "/?" + own);
      // Keep a bounded page-back cache. Every page can also be revisited by rescanning this window.
      pages = pages.slice(0, pageIndex + 1); pages.push(result.html); if (pages.length > 8) pages.shift(); pageIndex = pages.length - 1;
      if (pages.length > 1) addPrevious();
      if (result.count === 0 && result.next) { loading = false; clearTimeout(timeout); return load(result.next); }
    } catch (e) {
      if (mine === generation) status(e.name === "AbortError" ? "History read timed out. Read this window again." : "History could not be read. Read this window again.");
    } finally { clearTimeout(timeout); if (mine === generation) loading = false; }
  }
  function addPrevious() {
    const button = document.createElement("button"); button.className = "btn btn--sm"; button.setAttribute("type", "button"); button.textContent = "Previous page";
    button.addEventListener("click", () => { if (pageIndex > 0) { render(pages[--pageIndex]); init(); if (pageIndex > 0) addPrevious(); } });
    panel.querySelector("[data-history-load], [data-history-restart]")?.parentNode.appendChild(button);
  }
  function navigate(href) {
    const destination = new URL(href, location.origin);
    if (destination.origin !== location.origin || destination.pathname !== "/") return;
    href = destination.pathname + destination.search;
    controller?.abort(); generation++; loading = false; pages = []; pageIndex = -1;
    history.replaceState(null, "", href);
    pinned = new URLSearchParams(location.search).has("anchor");
    if (!pinned) { location.assign("/" + destination.search); return; }
    load(null, true);
  }
  panel.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button > 0) return;
    const run = e.target.closest?.(".tl-run");
    if (run && touched === run) { e.preventDefault(); touched = null; preview(run); return; }
    const target = e.target.closest?.("[data-history-nav], [data-history-load], [data-history-restart], [data-history-reveal]");
    if (!target) return;
    e.preventDefault();
    if (target.hasAttribute("data-history-nav")) navigate(target.getAttribute("href"));
    else if (target.hasAttribute("data-history-reveal")) {
      const list = panel.querySelector(".history-list");
      if (list) { list.parentNode.open = true; list.querySelector("a")?.focus(); }
      else load();
    }
    else if (target.hasAttribute("data-history-restart")) { pages = []; pageIndex = -1; load(); }
    else if (pageIndex < pages.length - 1) { render(pages[++pageIndex]); init(); if (pageIndex > 0) addPrevious(); }
    else load(frame()?.getAttribute("data-history-next") || null);
  });
  panel.addEventListener("submit", (e) => {
    if (!e.target.matches("[data-history-project]")) return;
    e.preventDefault(); const p = new URLSearchParams(new FormData(e.target)); if (!p.get("project")) p.delete("project"); navigate("/?" + p);
  });
  for (const event of ["pointerover", "focusin"]) panel.addEventListener(event, (e) => { const link = e.target.closest?.(".tl-run"); if (link) preview(link); });
  panel.addEventListener("touchstart", (e) => { const link = e.target.closest?.(".tl-run"); if (link) { touched = link; preview(link); } }, { passive: true });
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { const box = panel.querySelector("[data-history-preview]"); if (box) box.hidden = true; } });
  init();
  if (pinned) load();
  return { held: () => pinned || loading || panel.contains(document.activeElement) || panel.querySelector("[data-history-preview]")?.hidden === false, init };
}
