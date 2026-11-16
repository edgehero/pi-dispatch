import { Timeline } from "vis-timeline/esnext/esm/vis-timeline-graph2d.js";
import { DataSet } from "vis-data/peer/esm/vis-data.js";

const DAY = 86400000;
const TILE_LIMIT = 5000, TILE_COUNT = 8, GROUP_COUNT = 50, DETAIL_COUNT = 200;
const symbols = { ok: "✓", failed: "×", refused: "⊘", parked: "?", run: "▶", wait: "◷", held: "!" };
const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset" });
const local = (ms) => ms == null ? "Not recorded" : dateFormat.format(ms);
const intersects = (r, start, end) => r.start < end && (r.end ?? r.start) >= start;

/** Plain DOM text is the only sink for record strings; neither vis templates nor tooltips receive HTML from data. */
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

export function mountTimeline({ panel, person, personHeader, onAuth }) {
  let seed = JSON.parse(decodeURIComponent(panel.querySelector("[data-timeline-seed]").getAttribute("data-timeline-seed")));
  const app = panel.querySelector("[data-timeline-app]"), $ = (s) => app.querySelector(s);
  const saved = history.state?.runTimeline;
  const params = new URLSearchParams(location.search);
  let start = saved?.start ?? (params.has("anchor") || params.has("zoom") ? seed.start : seed.now - DAY * .85);
  let end = saved?.end ?? (params.has("anchor") || params.has("zoom") ? seed.end : seed.now + DAY * .15);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > 28 * DAY) { start = seed.start; end = seed.end; }
  let project = seed.project, rows = saved?.rows === "host" ? "host" : seed.rows;
  let following = !params.has("anchor") && saved?.following !== false;
  let selected = saved?.selected ?? null, expanded = saved?.expanded ?? null, detailPage = saved?.detailPage ?? 0, groupPage = saved?.groupPage ?? 0;
  let visible = new Map(), allVisible = [], tiles = new Map(), generation = 0, controller, busy = false, timer, destroyed = false;
  let pointer = null, dragged = false, lastTouch = 0, suppressFocus = false, olderAt = null;
  let savedValue = null, savedAt = -Infinity, saveTimer, previewValue = null, drawnValue = null, projectChipsValue = null, focusedRunId = null, revealFrame;
  let requestedStart = Math.round(start), requestedEnd = Math.round(end);
  const items = new DataSet(), groups = new DataSet(), itemVersions = new Map();
  const chartEl = $("[data-rt-chart]");
  app.hidden = false;
  panel.querySelector("[data-timeline-fallback]").hidden = true;
  panel.classList.add("timeline-enhanced");
  $("[data-rt-zone]").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
  const chart = new Timeline(chartEl, items, groups, {
    start, end, height: 440, min: 0, max: seed.now + 7 * DAY,
    zoomMin: 1000, zoomMax: 28 * DAY, editable: false, groupEditable: false,
    stack: false, stackSubgroups: true, selectable: false, showTooltips: false,
    horizontalScroll: false, verticalScroll: true, zoomKey: "ctrlKey", moveable: true,
    orientation: { axis: "bottom", item: "top" }, maxMinorChars: 17, loadingScreenTemplate: () => element("p", "Drawing timeline…"), margin: { item: { horizontal: 0, vertical: 8 }, axis: 10 },
    groupOrder: "order", showCurrentTime: false,
    format: { minorLabels: (date, scale) => ["millisecond", "second", "minute", "hour"].includes(scale) ? date.format("HH:mm [UTC]Z") : date.format("D MMM"), majorLabels: (date) => date.format("ddd D MMM YYYY") },
    template: (data) => {
      if (data.type === "background") return element("span");
      const r = data.run;
      const node = element("button", r.aggregate ? r.word : null, "rt-run");
      if (!r.aggregate) {
        const symbol = element("span", symbols[r.kind] ?? "·", "rt-symbol"); symbol.setAttribute("aria-hidden", "true");
        node.append(symbol, element("span", r.jobId, "rt-run-label"));
      }
      node.type = "button"; node.dataset.run = data.id; node.tabIndex = data.id === selected ? 0 : -1;
      node.setAttribute("aria-label", r.aggregate ? r.word + ". Expand this group." : [r.jobId, r.project ?? "No project", r.word, local(r.startedAt), r.endedAt == null ? null : "to " + local(r.endedAt)].filter(Boolean).join(". "));
      return node;
    },
    groupTemplate: (data) => {
      const button = element("button", null, "rt-group"); button.type = "button";
      const tag = element("span", data.label, "ptag"); tag.title = data.label; button.append(tag);
      if (data.target) button.append(element("span", data.target, "tl__repo"));
      button.dataset.group = data.id; button.setAttribute("aria-label", "Expand " + data.label); return button;
    },
  });
  const trackFocus = e => { focusedRunId = chartEl.contains(e.target) ? e.target.closest("[data-run]")?.dataset.run ?? null : null; };
  document.addEventListener("focusin", trackFocus);
  const nowLabel = element("span", null, "rt-now-label");
  // vis also redraws asynchronously for layout and custom-time changes, outside a data render.
  chart.on("changed", () => requestAnimationFrame(() => {
    if (destroyed) return;
    const marker = chartEl.querySelector(".vis-custom-time");
    if (marker && !marker.contains(nowLabel)) marker.append(nowLabel);
    if (!focusedRunId || document.activeElement !== document.body) return;
    const button = [...chartEl.querySelectorAll("[data-run]")].find(b => b.dataset.run === focusedRunId);
    button?.focus({preventScroll:true});
  }));
  chart.addCustomTime(seed.now, "now"); chart.setCustomTimeTitle("Now", "now");
  function labelNow() {
    nowLabel.textContent = new Intl.DateTimeFormat(undefined, {hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(seed.now);
    nowLabel.title = "Now · " + local(seed.now);
  }
  labelNow();

  function remember(force = false) {
    const state = { start: Math.round(start), end: Math.round(end), project, rows, following, selected, expanded, detailPage, groupPage };
    const value = JSON.stringify(state);
    if (value === savedValue) return;
    clearTimeout(saveTimer);
    // WebKit limits history writes. Streaming pages and pointer previews may change hundreds of times per second.
    if (force !== true && performance.now() - savedAt < 250) { saveTimer = setTimeout(() => remember(true), 250); return; }
    const p = new URLSearchParams(location.search);
    if (following) p.delete("anchor"); else p.set("anchor", String(Math.max(DAY, Math.min(seed.now, Math.round(end)))));
    if (project) p.set("project", project); else p.delete("project");
    if (rows === "host") p.set("rows", rows); else p.delete("rows");
    history.replaceState({ ...history.state, runTimeline: state }, "", "/" + (p.size ? "?" + p : ""));
    savedValue = value; savedAt = performance.now();
  }
  function orientation() {
    panel.querySelector(".card__head h2").textContent = rows === "host" ? "Runs by host" : "Runs by project";
    $("[data-rt-action=all-groups]").textContent = rows === "host" ? "All hosts" : "All projects";
    $("[data-rt-range]").textContent = local(start) + " – " + local(end);
    $("[data-rt-mode]").textContent = following ? "Live" : "Browsing history";
    const span = end - start, option = [...$("[data-rt-span]").options].find(o => Number(o.value) === Math.round(span));
    $("[data-rt-span]").value = option?.value ?? "custom";
    for (const button of app.querySelectorAll("[data-rt-preset]")) button.setAttribute("aria-pressed", String(Number(button.dataset.rtPreset) === Math.round(span)));
    for (const button of app.querySelectorAll("[data-rt-rows]")) button.setAttribute("aria-pressed", String(button.dataset.rtRows === rows));
  }
  function tileRanges() {
    const span = end - start, width = span > DAY ? 7 * DAY : DAY;
    const ranges = [];
    // The visible range has priority. Prefetch only one neighbouring tile on either side, within the cache bound.
    for (let at = Math.max(0, Math.floor(start / width) * width); at < end; at += width) ranges.push([at, at + width]);
    const a = ranges[0]?.[0], b = ranges.at(-1)?.[1];
    if (a >= width) ranges.push([a - width, a]);
    if (b < seed.now) ranges.push([b, Math.min(b + width, seed.now + 7 * DAY)]);
    return ranges.filter(([a,b]) => a < seed.now + 7 * DAY && b <= seed.now + 7 * DAY).slice(0, TILE_COUNT);
  }
  const tileKey = (a, b) => JSON.stringify([project, a, b]);
  function wanted() {
    return tileRanges().map(([a,b]) => {
      const key = tileKey(a,b);
      if (!tiles.has(key)) tiles.set(key, { key, start:a, end:b, items:new Map(), cursor:null, done:false, partial:false, olderAt:null, unavailable:[], capped:false, error:null, pages:0 });
      return tiles.get(key);
    });
  }
  function prune() {
    const keep = new Set(tileRanges().map(([a,b]) => tileKey(a,b)));
    for (const key of tiles.keys()) if (!keep.has(key) && tiles.size > TILE_COUNT) tiles.delete(key);
  }
  function status() {
    const current = wanted().filter(t => t.start < end && t.end > start);
    const unavailable = [...new Set(current.flatMap(t=>t.unavailable))];
    const error = current.some(t=>t.error), capped = current.some(t=>t.capped);
    const partial = current.some(t=>t.partial), complete = current.every(t=>t.done);
    const earlier = current.map(t=>t.olderAt).filter(Number.isFinite);
    olderAt = earlier.length ? Math.max(...earlier) : null;
    let word = error ? "History could not be read. Retry this range." : capped ? "This dense range has more runs. Continue loading, or zoom in and choose a project." : !complete ? "Reading retained history…" : partial ? "History is incomplete on the sources read." : "Range read on the available sources.";
    if (complete && !partial && !allVisible.length) word += " No runs in this window.";
    if (complete && !partial && olderAt === null) word += " No earlier run found on the sources read.";
    if (unavailable.length) word += " Unavailable: " + unavailable.join(", ") + ".";
    if (seed.notes?.length && following) word += " " + seed.notes.join(" ");
    $("[data-rt-status]").textContent = word;
    $("[data-rt-action=retry]").hidden = !error && !partial;
    $("[data-rt-action=more]").hidden = !capped;
    $("[data-rt-action=previous]").hidden = olderAt === null;
  }
  function render() {
    const focused = document.activeElement, focusedRun = focused?.dataset?.run;
    const records = new Map();
    for (const t of tiles.values()) for (const [key,r] of t.items) if ((!project || r.project === project) && intersects(r,start,end)) records.set(key,r);
    // The live snapshot overrides archive copies, but only for its own time window and jobs it still names.
    for (const r of seed.items) if ((!project || r.project === project) && intersects(r,start,end)) records.set(r.id,r);
    allVisible = [...records.values()].sort((a,b)=>a.start-b.start || a.id.localeCompare(b.id));
    const byGroup = new Map();
    for (const r of allVisible) { const name = r[rows] ?? "(unassigned)"; if (!byGroup.has(name)) byGroup.set(name,[]); byGroup.get(name).push(r); }
    const names = [...byGroup.keys()].sort();
    const shownNames = expanded && byGroup.has(expanded) ? [expanded] : names.slice(groupPage*GROUP_COUNT,(groupPage+1)*GROUP_COUNT);
    const draw = [{ id:"background:future", start:seed.now, end:seed.now+7*DAY, type:"background", className:"rt-future" }], drawGroups = []; visible = new Map();
    for (const [order,name] of shownNames.entries()) {
      const runs = byGroup.get(name), expandedGroup = expanded === name;
      const targets = [...new Set(runs.map(r => r.target?.replace(/#\d+$/, "")).filter(Boolean))];
      drawGroups.push({ id:name, label:name, content:name, target: targets.length === 1 ? targets[0] : null, order });
      const lanes = [], overflow = [];
      for (const r of expandedGroup ? runs.slice(detailPage*DETAIL_COUNT,(detailPage+1)*DETAIL_COUNT) : runs) {
        const minWidth = (end-start)*24/Math.max(200,chartEl.clientWidth-150);
        let lane = lanes.findIndex(e=>e <= r.start);
        if (lane < 0) lane = lanes.length;
        if (!expandedGroup && (lane >= 3 || draw.length > 600)) { overflow.push(r); continue; }
        lanes[lane] = Math.max(r.end ?? r.start,r.start+minWidth);
        visible.set(r.id,r);
        draw.push({id:r.id,group:name,subgroup:lane, start:r.start,end:Math.max(r.end ?? r.start,r.start+1),type:"range",className:"rt-item rt-"+r.kind,run:r});
      }
      if (overflow.length) {
        const r={id:"group:"+name,aggregate:true,group:name,start:Math.min(...overflow.map(r=>r.start)),end:Math.max(...overflow.map(r=>r.end??r.start)),word:"+"+overflow.length+" runs · Expand"};
        visible.set(r.id,r);draw.push({id:r.id,group:name,subgroup:3,start:r.end,type:"box",align:"right",className:"rt-item rt-aggregate",run:r});
      }
    }
    // Update the persistent DataSets. A load never replaces the viewport or the library instance.
    const drawing = JSON.stringify(draw), changed = drawing !== drawnValue;
    if (changed) {
      drawnValue = drawing;
      groups.update(drawGroups.filter(g => groups.get(g.id)?.order !== g.order || groups.get(g.id)?.target !== g.target));
      groups.remove(groups.getIds().filter(id=>!shownNames.includes(id)));
      items.update(draw.filter(item => {
        const value = JSON.stringify(item);
        if (itemVersions.get(item.id) === value) return false;
        itemVersions.set(item.id, value); return true;
      }));
      const removed = items.getIds().filter(id=>id!=="background:future"&&!visible.has(id));
      items.remove(removed); for (const id of removed) itemVersions.delete(id);
    }
    const density = $("[data-rt-density]"), expandedRuns = byGroup.get(expanded) ?? [];
    density.hidden = !expanded && names.length <= GROUP_COUNT;
    density.querySelector("span").textContent = expanded ? expanded+" · Runs "+(detailPage*DETAIL_COUNT+1)+"–"+Math.min((detailPage+1)*DETAIL_COUNT,expandedRuns.length)+" of "+expandedRuns.length+" loaded" : (rows === "host" ? "Hosts " : "Projects ")+(groupPage*GROUP_COUNT+1)+"–"+Math.min((groupPage+1)*GROUP_COUNT,names.length)+" of "+names.length;
    $("[data-rt-action=back-page]").disabled = expanded ? detailPage===0 : groupPage===0;
    $("[data-rt-action=next-page]").disabled = expanded ? (detailPage+1)*DETAIL_COUNT>=expandedRuns.length : (groupPage+1)*GROUP_COUNT>=names.length;
    if (changed) {
    renderList();
    const projects=[...new Set([...seed.items,...records.values()].map(r=>r.project).filter(Boolean))].sort().slice(0,200);
    $("#rt-projects").replaceChildren(...projects.map(p=>{const o=element("option");o.value=p;return o;}));
    const shownProjects = projects.slice(0, 8);
    if (project && !shownProjects.includes(project)) shownProjects.push(project);
    const chipsValue = JSON.stringify(shownProjects);
    if (chipsValue !== projectChipsValue) {
      projectChipsValue = chipsValue;
      const chips = $("[data-rt-project-chips]");
      const focusedFilter = chips.contains(document.activeElement) ? document.activeElement.dataset.rtFilter : undefined;
      chips.replaceChildren(element("span", "Project", "projseg__l"));
      for (const name of [null, ...shownProjects]) {
        const button = element("button", name ? null : "All"); button.type = "button";
        button.dataset.rtFilter = name ?? ""; button.setAttribute("aria-pressed", String(name === project));
        if (name) button.append(element("span", name, "ptag"));
        chips.append(button);
      }
      if (focusedFilter !== undefined) [...chips.querySelectorAll("button")].find(button => button.dataset.rtFilter === focusedFilter)?.focus({preventScroll:true});
    }
    for (const button of app.querySelectorAll("[data-rt-filter]")) button.setAttribute("aria-pressed", String((button.dataset.rtFilter || null) === project));
    }
    if (selected && records.has(selected)) preview(records.get(selected),false);
    if (focusedRun) requestAnimationFrame(() => {
      // Library updates replace item DOM. Restore its focus only if the person has not moved elsewhere meanwhile.
      if (!focused.isConnected && document.activeElement === document.body) {
        const replacement = [...chartEl.querySelectorAll("[data-run]")].find(b => b.dataset.run === focusedRun);
        (replacement ?? chartEl).focus({preventScroll:true});
      }
    });
    orientation();status();remember();
  }
  function renderList() {
    const list=$("[data-rt-list]"); list.replaceChildren();
    if (!list.parentElement.open) return;
    for (const r of visible.values()) if (!r.aggregate) {
      const li=element("li"),a=element("a",r.jobId+" · "+r.word+" · "+local(r.startedAt));
      a.href=r.href;li.append(a);list.append(li);
    }
  }
  $("[data-rt-list]").parentElement.addEventListener("toggle",renderList);
  function preview(r, focus=false) {
    if (!r || r.aggregate) return;
    selected=r.id;
    const box=$("[data-rt-preview]"), value=JSON.stringify(r);
    if (value!==previewValue || box.hidden) {
    previewValue=value;box.replaceChildren();box.hidden=false;
    box.append(element("strong",r.jobId),element("p",(r.project??"No project")+" · "+(r.host??"Host not recorded")),element("p",r.target),element("p",(symbols[r.kind]??"·")+" "+r.word,"rt-outcome"));
    const dl=element("dl");
    const fields=[[r.kind==="wait"?"Due / next check":"Started",r.kind==="wait"?local(r.start):local(r.startedAt)],["Ended",local(r.endedAt)]];
    if(r.startedAt!=null&&r.endedAt!=null) fields.push(["Duration",Math.max(0,(r.endedAt-r.startedAt)/1000).toLocaleString()+" seconds"]);
    for(const [k,v] of fields) dl.append(element("dt",k),element("dd",v));box.append(dl);
    const open=element("a","Open run","btn");open.href=r.href;open.addEventListener("click",()=>remember(true));
    const close=element("button","Close","btn btn--sm btn--ghost");close.type="button";close.addEventListener("click",()=>{selected=null;box.hidden=true;suppressFocus=true;chartEl.focus({preventScroll:true});suppressFocus=false;remember();});
    box.append(open,close);
    }
    for(const b of chartEl.querySelectorAll("[data-run]")) { b.tabIndex=b.dataset.run===selected?0:-1;b.setAttribute("aria-pressed",String(b.dataset.run===selected)); }
    if(focus) {
      const b=[...chartEl.querySelectorAll("[data-run]")].find(b=>b.dataset.run===selected);
      b?.focus({preventScroll:true});
      revealSelected();
    }
    remember();
  }
  function revealSelected() {
    cancelAnimationFrame(revealFrame);
    // Let the native scroll event and vis's throttled redraw settle before measuring again. WebKit
    // may otherwise measure an earlier lane during rapid arrow presses and leave the final run clipped.
    revealFrame=requestAnimationFrame(()=>{revealFrame=requestAnimationFrame(()=>{
      if(destroyed||focusedRunId!==selected)return;
      const button=[...chartEl.querySelectorAll("[data-run]")].find(b=>b.dataset.run===selected);
      const rect=button?.getBoundingClientRect(),frame=chartEl.querySelector(".vis-panel.vis-center").getBoundingClientRect();
      if(!rect)return;
      // vis 8.5.6 focus() calculates item height from the axis orientation, which is wrong for a bottom
      // ruler with top-aligned items. Its native side scrollbar reveals a lane without moving time.
      const delta=rect.top<frame.top?rect.top-frame.top-8:rect.bottom>frame.bottom?rect.bottom-frame.bottom+8:0;
      if(!delta)return;
      const scrollbar=chartEl.querySelector(".vis-panel.vis-left"),before=scrollbar.scrollTop;
      scrollbar.scrollTop+=delta;
      if(scrollbar.scrollTop!==before)revealSelected();
    });});
  }
  function expand(name) {following=false;expanded=name;detailPage=0;render();chart.redraw();}
  function changeRange(a,b,user=true) {
    if(user)following=false;
    detailPage=0;
    chart.setWindow(Math.max(0,a),Math.max(1000,b),{animation:false});
    const window = chart.getWindow();
    requestedStart = Math.round(+window.start); requestedEnd = Math.round(+window.end);
    schedule();
  }
  function schedule() {
    clearTimeout(timer);controller?.abort();generation++;
    $("[data-rt-status]").textContent = "Reading retained history…";
    timer=setTimeout(()=>{render();pump();},160);
  }
  async function pump() {
    if(busy||destroyed)return;
    busy=true;const own=generation;
    try {
      for(const tile of wanted()) {
        if(own!==generation||destroyed)break;
        if(tile.done||tile.capped||tile.error)continue;
        do {
          const p=new URLSearchParams({format:"data",start:String(tile.start),end:String(tile.end)});
          if(project)p.set("project",project);if(tile.cursor)p.set("cursor",tile.cursor);
          controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
          try {
            const response=await fetch("/api/timeline?"+p,{credentials:"same-origin",headers:person?{[personHeader]:person}:{},signal:controller.signal});
            if(response.status===401||response.status===403){onAuth();destroy();return;}
            if(!response.ok)throw new Error("history-read");
            const data=await response.json();
            if(own!==generation){
              // The server may have advanced this cursor even though its response is no longer wanted.
              if(tiles.get(tile.key)===tile)tiles.delete(tile.key);
              return;
            }
            for(const r of data.items) tile.items.set(r.id,r);
            tile.cursor=data.next;tile.done=!data.next;tile.partial=data.partial;tile.unavailable=data.unavailable??[];tile.olderAt=data.olderAt;tile.pages++;
            tile.capped=tile.items.size>TILE_LIMIT-100&&!tile.done;
            render();prune();
          } catch(error) {
            if(own!==generation&&tiles.get(tile.key)===tile)tiles.delete(tile.key);
            if(own===generation&&error.name!=="AbortError")tile.error="unreadable";
            else if(own===generation)tile.error="timeout";
            break;
          } finally {clearTimeout(timeout);}
          // Yield even for empty scan pages so gestures and live events can cancel a long archive walk.
          await new Promise(resolve=>setTimeout(resolve,0));
        } while(!tile.done&&!tile.capped&&own===generation&&!destroyed);
      }
    } finally {busy=false;if(!destroyed){status();if(own!==generation)pump();}}
  }
  chart.on("rangechange",e=>{start=+e.start;end=+e.end;if(e.byUser){following=false;detailPage=0;}orientation();});
  chart.on("rangechanged",e=>{
    // vis can finish measuring sparse data before its initial range notification. Finish that draw as well.
    if (chartEl.querySelector(".vis-timeline")?.style.visibility === "hidden") requestAnimationFrame(() => chart.redraw());
    const a=Math.round(+e.start),b=Math.round(+e.end);
    // vis also announces unchanged ranges after layout. Those redraws must not reset an expanded group's page.
    if(a===requestedStart&&b===requestedEnd)return;
    requestedStart=a;requestedEnd=b;schedule();
  });
  chartEl.addEventListener("wheel",e=>{
    if(e.ctrlKey)return;
    const dx=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.shiftKey?e.deltaY:0;
    if(!dx)return;e.preventDefault();e.stopImmediatePropagation();
    const delta=dx*(end-start)/Math.max(200,chartEl.clientWidth);changeRange(start+delta,end+delta);
  },{passive:false,capture:true});
  chartEl.addEventListener("pointerdown",e=>{pointer={x:e.clientX,y:e.clientY};dragged=false;if(e.pointerType==="touch")lastTouch=performance.now();});
  chartEl.addEventListener("pointermove",e=>{if(pointer&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>6)dragged=true;});
  window.addEventListener("pointerup",()=>{pointer=null;});
  chartEl.addEventListener("click",e=>{
    const group=e.target.closest("[data-group]");if(group&&!dragged){expand(group.dataset.group);return;}
    const button=e.target.closest("[data-run]");if(!button||dragged)return;
    const r=visible.get(button.dataset.run);if(r?.aggregate){expand(r.group);return;}
    if(performance.now()-lastTouch<1000){preview(r);return;}
    if(r){preview(r);remember(true);if(e.ctrlKey||e.metaKey)window.open(r.href,"_blank","noopener");else location.assign(r.href);}
  });
  chartEl.addEventListener("pointerover",e=>{if(e.pointerType==="touch"||pointer)return;const b=e.target.closest("[data-run]");if(b)preview(visible.get(b.dataset.run));});
  chartEl.addEventListener("focusin",e=>{if(suppressFocus)return;const b=e.target.closest("[data-run]");if(b)preview(visible.get(b.dataset.run));});
  chartEl.addEventListener("keydown",e=>{
    if(e.key==="Escape"){selected=null;$("[data-rt-preview]").hidden=true;chartEl.focus();remember();return;}
    if(["+","-"].includes(e.key)){e.preventDefault();const f=e.key==="+"?.5:2,c=(start+end)/2;changeRange(c-(end-start)*f/2,c+(end-start)*f/2);return;}
    const current=visible.get(selected),entries=[...visible.values()];
    if(e.key==="Enter"&&current){e.preventDefault();if(current.aggregate)expand(current.group);else{remember(true);location.assign(current.href);}return;}
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;e.preventDefault();
    if(e.shiftKey){const d=(e.key==="ArrowLeft"?-1:1)*(end-start)*.5;changeRange(start+d,end+d);return;}
    const list=entries.filter(r=>!r.aggregate);let at=list.findIndex(r=>r.id===selected),next;
    if(e.key==="ArrowUp"||e.key==="ArrowDown"){
      const ns=[...new Set(list.map(r=>r[rows]))],i=ns.indexOf(current?.[rows]),name=ns[Math.max(0,Math.min(ns.length-1,i+(e.key==="ArrowUp"?-1:1)))];next=list.find(r=>r[rows]===name);
    }else next=list[Math.max(0,Math.min(list.length-1,at+(e.key==="ArrowLeft"?-1:1)))];
    if(next)preview(next,true);
  });
  function filterProject(value) {
    project=value||null;expanded=null;detailPage=0;groupPage=0;tiles.clear();
    $("[data-rt-project] input").value=project??"";
    drawnValue=null;schedule();
  }
  app.addEventListener("submit",e=>{if(!e.target.matches("[data-rt-project]"))return;e.preventDefault();filterProject(e.target.elements.project.value);});
  $("[data-rt-span]").addEventListener("change",e=>{const span=Number(e.target.value),at=visible.get(selected)?.start??(start+end)/2;changeRange(at-span/2,at+span/2);});
  app.addEventListener("click",e=>{
    const filter=e.target.closest("[data-rt-filter]");if(filter){filterProject(filter.dataset.rtFilter);return;}
    const grouping=e.target.closest("[data-rt-rows]");if(grouping){rows=grouping.dataset.rtRows;expanded=null;detailPage=0;groupPage=0;render();return;}
    const preset=e.target.closest("[data-rt-preset]");if(preset){const span=Number(preset.dataset.rtPreset),at=visible.get(selected)?.start??(start+end)/2;changeRange(at-span/2,at+span/2);return;}
    const button=e.target.closest("[data-rt-action]");if(!button)return;
    const action=button.dataset.rtAction,span=end-start,at=visible.get(selected)?.start??(start+end)/2;
    if(action==="older"||action==="newer"){const d=span*.6*(action==="older"?-1:1);changeRange(start+d,end+d);}
    if(action==="in"||action==="out"){const next=span*(action==="in"?.5:2);changeRange(at-next/2,at+next/2);}
    if(action==="now"){following=true;changeRange(seed.now-span*.85,seed.now+span*.15,false);}
    if(action==="expand"){const on=app.classList.toggle("rt-expanded");button.textContent=on?"Collapse":"Expand";button.setAttribute("aria-expanded",String(on));chart.setOptions({height:on?Math.max(300,innerHeight-260):440});}
    if(action==="all-groups"){expanded=null;detailPage=0;render();}
    if(action==="back-page"||action==="next-page"){const d=action==="next-page"?1:-1;if(expanded)detailPage=Math.max(0,detailPage+d);else groupPage=Math.max(0,groupPage+d);render();}
    if(action==="retry"){tiles.clear();schedule();}
    if(action==="previous"&&olderAt!=null)changeRange(olderAt-span*.85,olderAt+span*.15);
    if(action==="more"){for(const t of wanted())if(t.capped){t.items.clear();t.capped=false;}schedule();}
  });
  function updateMarkup(markup) {
    const template=document.createElement("template");template.innerHTML=markup;
    const incoming=template.content.querySelector("[data-timeline-seed]");if(!incoming)return;
    const next=JSON.parse(decodeURIComponent(incoming.getAttribute("data-timeline-seed"))),delta=next.now-seed.now;seed=next;
    chart.setCustomTime(seed.now,"now");labelNow();chart.setOptions({max:seed.now+7*DAY});
    if(following&&delta>0)changeRange(start+delta,end+delta,false);else render();
  }
  function destroy(){destroyed=true;document.removeEventListener("focusin",trackFocus);cancelAnimationFrame(revealFrame);clearTimeout(timer);clearTimeout(saveTimer);controller?.abort();chart.destroy();tiles.clear();}
  window.addEventListener("pagehide",()=>{remember(true);clearTimeout(saveTimer);controller?.abort();});
  window.addEventListener("pageshow",e=>{if(e.persisted)schedule();});
  render();pump();
  return { held:()=>true, init:()=>{}, updateMarkup, destroy };
}

window.piDispatchTimeline = mountTimeline;
