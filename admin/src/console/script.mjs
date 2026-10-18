/**
 * The console's one browser script, served from `/static/console.js` (issue #640). A string module rather than a file
 * beside the bundle: `dist/console.mjs` ships as one file, and a script read from disk at runtime would need a second
 * artifact the bundle could lose. The CSP's `script-src 'self'` accepts it because it arrives from a URL on this
 * origin; nothing here is ever inlined into a page.
 *
 * What it does, per page (`data-page` on the body):
 *   - `login`: submits the token as JSON (a form-encoded POST is refused by the server), clears the field either way.
 *   - `login-code`: reads the one-time code from `location.hash`, drops the fragment from history with
 *     `history.replaceState` BEFORE posting it (so the back button and a session restore cannot replay it), then posts
 *     it. The code travels in the fragment because a fragment never reaches the server's request line, a log or a
 *     Referer.
 *   - every signed-in page: the sign-out button (`#logout`).
 *   - a LIVE page (issue #641; `data-live` on the body): opens `/api/events?page=<data-live>&<data-query>` with
 *     `EventSource`. An `event: panel` carries `{id, html}`, and its html replaces the inner HTML of the element with
 *     that id ONLY when that element carries `data-panel`: the server renders and escapes the fragment (the same
 *     renderer as the page load), and the guard keeps a message from aiming at any other element. `event: end` (the
 *     session ended, was revoked or expired) closes the stream and goes to `/login`. `#live-status` says "live" or
 *     "reconnecting", through `textContent`; `EventSource` reconnects by itself and resends `Last-Event-ID`.
 *   - the SPEND SCREEN (`insights`): what the offline insights page's own script did, under this CSP. The insights
 *     renderers mark each bar with `data-tip="<n>"` and the page lists the texts in `#insights-tips` (escaped by the
 *     server); hovering a bar shows its text in the topology's `#tip` box through `textContent`. The topology pans
 *     (drag), zooms (wheel), shows each chip's tooltip, selects a chip with its neighbours and wires (click; Escape
 *     clears), and keeps the view in the fragment; a breakdown row (`data-node`, a minted `n<k>`) replays a click at its
 *     chip. The chips' data comes from `#graph-nodes`, a hidden list the server escaped, never from an inline script.
 *     `FIT_JS` (graph-html.mjs, the one label fitter) shortens a drawn label that runs past its box and adds a `<title>`
 *     through the DOM. All of it runs on the spend screen only.
 *   - the ACTION FORMS (issue #642; `form[data-action]`, drawn for an operator only): one handler, delegated from the
 *     document so a form a live panel swapped in works too. Submit reads the form's named controls into JSON (`data-type`
 *     says how: `int`, `json`, `list`, a checkbox is `true`; a blank control is left out), posts it to
 *     `/api/act/<data-action>/preview`, and puts the response's `diffHtml` (server-rendered and escaped, like a panel)
 *     into THAT form's own `[data-preview]` element and nowhere else, with a Confirm and a Cancel button built here. The
 *     ticket stays in this closure; Confirm posts it to `/api/act/<name>/confirm`. A 409 shows the server's refusal
 *     (the change happened since the preview, or was refused), which says to preview again; one that does not gets
 *     that instruction added once. Success reloads the page; a bulk action with jobs refused shows
 *     each job's result first, as text, with a button to reload.
 *   - while a form is in use (its preview open, a field typed into or focused, its editor open), a live panel holding it
 *     is NOT swapped, so an update cannot wipe a half-made change; the page reloads after a confirm anyway.
 *   - the run page's LIVE TRANSCRIPT (issue #643; `[data-transcript]`, drawn for an operator only): opens
 *     `/api/transcript?id=<data-job>` with `EventSource`. Each `event: entry` carries `{html}`, server-rendered and
 *     escaped, which is APPENDED to that one element (`insertAdjacentHTML("beforeend")`) and nowhere else. The view
 *     follows the bottom unless the operator has scrolled up. `[data-transcript-status]` says "live", "reconnecting",
 *     "ended (<outcome>)" or "not live", through `textContent`. `event: done` (the run is over) closes the stream, so it
 *     is not reopened; `event: end` (the session ended) goes to `/login`. A dropped stream reconnects by itself and
 *     resends the last entry's id as `Last-Event-ID`, so nothing is appended twice.
 * Server text is shown with `textContent`, never as markup; the `innerHTML` writes are the panel swap, the preview
 * swap and the transcript append above, all of server-escaped fragments into elements the server marked for them.
 */
import { FIT_JS } from "../graph-html.mjs";

export const CONSOLE_SCRIPT = `"use strict";
(function () {
  var page = document.body ? document.body.getAttribute("data-page") : null;
  function say(text) {
    var el = document.getElementById("notice");
    if (el) el.textContent = text;
  }
  function post(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { ok: res.ok, status: res.status, body: json };
      });
    });
  }
  function failed(r) {
    say((r.body && typeof r.body.error === "string") ? r.body.error : "The console refused the request (" + r.status + ").");
  }
  if (page === "login") {
    var form = document.getElementById("login-form");
    var input = document.getElementById("token");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var token = input.value;
      input.value = "";
      post("/login", { token: token }).then(function (r) {
        if (r.ok) location.assign("/");
        else failed(r);
      }, function () { say("The console could not be reached."); });
    });
  } else if (page === "login-code") {
    var code = location.hash.length > 1 ? location.hash.slice(1) : "";
    history.replaceState(null, "", location.pathname);
    if (code === "") {
      say("This link carries no code. Ask for a new one with pi-dispatch-console link.");
    } else {
      post("/login/code", { code: code }).then(function (r) {
        if (r.ok) location.replace("/");
        else failed(r);
      }, function () { say("The console could not be reached."); });
    }
  }
  var out = document.getElementById("logout");
  if (out) out.addEventListener("click", function () {
    post("/logout", {}).then(function () { location.assign("/login"); }, function () { location.assign("/login"); });
  });
  // ---- the spend screen: chart tooltips and the interactive topology ----
  if (page === "insights") {
    try { fitInsightsLabels(); } catch (e) { /* the labels stay as drawn */ }
    insightsPage();
  }
  function fitInsightsLabels() {
${FIT_JS}
  }
  function insightsPage() {
    var tip = document.getElementById("tip");
    var wrap = document.getElementById("wrap");
    var svg = document.getElementById("graph");
    var root = document.getElementById("root");
    if (!tip || !wrap) return;
    // The texts the server listed, escaped, in two hidden lists: each chart tooltip (#insights-tips, by its data-tip
    // index) and each topology chip's tooltip, neighbours and wires (#graph-nodes, by minted id). Read as text and
    // attributes only; the offline page carried the same data as a JSON literal in an inline script, which the console's
    // CSP refuses.
    var tipsList = document.getElementById("insights-tips");
    var TIPS = [];
    if (tipsList) {
      var lis = tipsList.getElementsByTagName("li");
      for (var a = 0; a < lis.length; a++) TIPS.push(lis[a].textContent);
    }
    var NODES = {};
    var nodeList = document.getElementById("graph-nodes");
    if (nodeList) {
      var items = nodeList.getElementsByTagName("li");
      for (var b = 0; b < items.length; b++) {
        var nid = items[b].getAttribute("data-id");
        // Minted ordinals only, by the server's own rules (panels.mjs, NODE_ID_RE and WIRE_ID_RE): a chip id for the item
        // and its neighbours, a wire id for its wires. A prototype-chain key or a stray attribute never becomes a node.
        if (nid === null || !/^n\\d{1,6}$/.test(nid)) continue;
        var words = function (v, re) { return (v || "").split(" ").filter(function (w) { return re.test(w); }); };
        NODES[nid] = { tip: items[b].textContent, nb: words(items[b].getAttribute("data-nb"), /^n\\d{1,6}$/), w: words(items[b].getAttribute("data-w"), /^w\\d{1,6}$/) };
      }
    }
    // The ONLY indexed read of NODES: an id from the hash or the DOM could be "constructor", which a bare lookup returns.
    function ownNode(id) {
      return Object.prototype.hasOwnProperty.call(NODES, id) ? NODES[id] : null;
    }
    var mine = false;
    function place(e) {
      tip.style.display = "block";
      var wr = wrap.getBoundingClientRect();
      tip.style.left = e.clientX - wr.left + 14 + "px";
      tip.style.top = e.clientY - wr.top + 14 + "px";
    }
    function showChartTip(el, e) {
      var i = parseInt(el.getAttribute("data-tip"), 10);
      // The index rides a DOM attribute, so it is bounds-checked before it is used; a bad one shows nothing.
      if (!(i >= 0 && i < TIPS.length)) return false;
      tip.textContent = TIPS[i];
      place(e);
      mine = true;
      return true;
    }
    function hideChartTip() {
      // Only what the charts showed: the topology drives the same box for its chips, and blanking it on every stray move
      // would fight that code mid-hover.
      if (!mine) return;
      mine = false;
      tip.textContent = "";
      tip.style.display = "none";
    }
    document.addEventListener("pointermove", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (!el || !showChartTip(el, e)) hideChartTip();
    });
    // pointerleave does not bubble, so delegation needs the capture phase to see a bar's exit.
    document.addEventListener("pointerleave", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (el) hideChartTip();
    }, true);
    // A breakdown row selects its trigger's chip: the click is replayed at the chip, so the topology's own handler stays
    // the one owner of the selection.
    document.addEventListener("click", function (e) {
      var row = e.target && e.target.closest ? e.target.closest("[data-node]") : null;
      if (!row) return;
      var id = row.getAttribute("data-node");
      if (id === null || !/^n\\d+$/.test(id)) return;
      var chip = document.getElementById(id);
      if (!chip) return;
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    if (!svg || !root || !svg.viewBox || !svg.viewBox.baseVal) return;
    var vb = svg.viewBox.baseVal;
    // How far the view zooms, as the drawn width over the view's: the wheel stops here, and a fragment is held to it.
    var ZOOM_MIN = 0.15;
    var ZOOM_MAX = 4;
    var baseW = vb.width;
    var baseH = vb.height;
    var selected = null;
    var hashTimer = null;
    // The view (the viewBox and the selection) rides the fragment, so a reload or a shared link keeps it. The fragment
    // never reaches the server.
    function writeHash() {
      hashTimer = null;
      var parts = ["vb=" + [vb.x, vb.y, vb.width, vb.height].map(function (v) { return Math.round(v * 10) / 10; }).join("_")];
      if (selected) parts.push("sel=" + selected);
      history.replaceState(null, "", location.pathname + location.search + "#" + parts.join("&"));
    }
    function scheduleHash() {
      if (hashTimer) return;
      hashTimer = setTimeout(writeHash, 300);
    }
    function clamp(x, lo, hi) {
      return x < lo ? lo : x > hi ? hi : x;
    }
    function readHash() {
      var h = location.hash.replace(/^#/, "");
      if (!h) return;
      var kvs = h.split("&");
      for (var i = 0; i < kvs.length; i++) {
        var at = kvs[i].indexOf("=");
        if (at < 0) continue;
        var k = kvs[i].slice(0, at);
        var v = kvs[i].slice(at + 1);
        if (k === "vb") {
          var n = v.split("_").map(parseFloat);
          if (n.length === 4 && n.every(isFinite) && n[2] > 0 && n[3] > 0) {
            // Clamped, because the fragment is anyone's to write: a viewBox attribute is a 32-bit float, and assigning
            // one past its range (vb=1e39_0_1_1) throws in Chromium. The size takes the wheel's own zoom bounds; the
            // origin a range far wider than any pan reaches.
            var far = 100 * Math.max(baseW, baseH, 1);
            vb.x = clamp(n[0], -far, far); vb.y = clamp(n[1], -far, far);
            vb.width = clamp(n[2], baseW / ZOOM_MAX, baseW / ZOOM_MIN); vb.height = clamp(n[3], baseH / ZOOM_MAX, baseH / ZOOM_MIN);
          }
        } else if (k === "sel" && ownNode(v)) {
          select(v);
        }
      }
    }
    // With preserveAspectRatio meet, the browser scales UNIFORMLY (the smaller of the two ratios) and centres the
    // remainder; mapping each axis by its own ratio pans at the wrong speed and zooms beside the cursor.
    function view() {
      var r = svg.getBoundingClientRect();
      var sc = Math.min(r.width / vb.width, r.height / vb.height);
      return { r: r, s: sc, ox: (r.width - vb.width * sc) / 2, oy: (r.height - vb.height * sc) / 2 };
    }
    var panning = null;
    var suppressClick = false;
    // The chip under the last press. setPointerCapture retargets the click that follows to the svg itself (Chromium), so
    // the click handler alone never sees a chip a mouse clicked; it falls back to this one. A row's replayed click has
    // no press, and finds its chip as its target.
    var pressed = null;
    svg.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      pressed = nodeAt(e);
      panning = { x: e.clientX, y: e.clientY, moved: 0 };
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    });
    function nodeAt(e) {
      var el = e.target && e.target.closest ? e.target.closest(".gnode") : null;
      return el && ownNode(el.id) ? el : null;
    }
    function moveTip(e) {
      var el = nodeAt(e);
      if (!el) { if (!mine) tip.style.display = "none"; return; }
      tip.textContent = ownNode(el.id).tip;
      place(e);
      mine = false;
    }
    svg.addEventListener("pointermove", function (e) {
      if (panning) {
        var v = view();
        var dx = e.clientX - panning.x;
        var dy = e.clientY - panning.y;
        panning.moved += Math.abs(dx) + Math.abs(dy);
        vb.x -= dx / v.s;
        vb.y -= dy / v.s;
        panning.x = e.clientX;
        panning.y = e.clientY;
        scheduleHash();
      }
      moveTip(e);
    });
    svg.addEventListener("pointerup", function (e) {
      if (panning && svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      // Pointer capture makes the click after a pan land on the svg, which would read as a background click and wipe the
      // selection; a real drag therefore swallows that click.
      suppressClick = panning !== null && panning.moved > 3;
      panning = null;
    });
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var k = Math.exp(-e.deltaY * 0.0015);
      var scale = baseW / (vb.width / k);
      if (scale < ZOOM_MIN || scale > ZOOM_MAX) return;
      var v = view();
      var px = vb.x + (e.clientX - v.r.left - v.ox) / v.s;
      var py = vb.y + (e.clientY - v.r.top - v.oy) / v.s;
      vb.x = px - (px - vb.x) / k;
      vb.y = py - (py - vb.y) / k;
      vb.width = vb.width / k;
      vb.height = vb.height / k;
      scheduleHash();
    }, { passive: false });
    function mark(id) {
      var el = document.getElementById(id);
      if (el) el.classList.add("hi");
    }
    function clearSel() {
      selected = null;
      root.classList.remove("dim");
      var hi = root.querySelectorAll(".hi");
      for (var i = 0; i < hi.length; i++) hi[i].classList.remove("hi");
      scheduleHash();
    }
    function select(id) {
      clearSel();
      var g = ownNode(id);
      if (!g) return;
      selected = id;
      root.classList.add("dim");
      mark(id);
      for (var i = 0; i < g.nb.length; i++) mark(g.nb[i]);
      for (var j = 0; j < g.w.length; j++) mark(g.w[j]);
      scheduleHash();
    }
    svg.addEventListener("click", function (e) {
      var el = nodeAt(e) || pressed;
      pressed = null;
      if (suppressClick) { suppressClick = false; return; }
      if (el) { if (selected === el.id) clearSel(); else select(el.id); }
      else clearSel();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") clearSel(); });
    // Last, and guarded: the fragment is anyone's to write, and a throw from it must not escape insightsPage() and take
    // the rest of this script (the action forms, the live stream) down with it. The view stays as drawn.
    try { readHash(); } catch (e) { /* the view stays as drawn */ }
  }
  // ---- the action forms (issue #642) ----
  function inUse(panel) {
    if (panel.querySelector("[data-preview]:not([hidden])")) return true;
    if (panel.querySelector("details[open] form[data-action]")) return true;
    var active = document.activeElement;
    if (active && panel.contains(active) && active.closest && active.closest("form[data-action]")) return true;
    var fields = panel.querySelectorAll("form[data-action] input:not([type=hidden]), form[data-action] textarea");
    for (var i = 0; i < fields.length; i++) if (fields[i].value !== fields[i].defaultValue) return true;
    return false;
  }
  function bodyOf(form) {
    var out = {};
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name || el.disabled) continue;
      if (el.type === "checkbox") { if (el.checked) out[el.name] = true; continue; }
      var v = el.value;
      if (v === "") continue;
      var t = el.getAttribute("data-type");
      if (t === "int") {
        var n = Number(v);
        if (!isFinite(n)) throw new Error(el.name + " must be a number");
        out[el.name] = n;
      } else if (t === "json") {
        try { out[el.name] = JSON.parse(v); } catch (e) { throw new Error(el.name + " is not valid JSON"); }
      } else if (t === "list") {
        out[el.name] = v.split(/[\\s,]+/).filter(function (w) { return w !== ""; });
      } else {
        out[el.name] = v;
      }
    }
    return out;
  }
  function show(area, text) {
    area.hidden = false;
    area.textContent = text;
  }
  function button(label) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    return b;
  }
  function errorOf(r) {
    return (r.body && typeof r.body.error === "string") ? r.body.error : "The console refused the request (" + r.status + ").";
  }
  function showResults(area, results) {
    area.textContent = "";
    var list = document.createElement("ul");
    for (var i = 0; i < results.length; i++) {
      var li = document.createElement("li");
      var r = results[i] || {};
      li.textContent = String(r.jobId) + ": " + (r.ok ? "done" : "not done, " + String(r.reason || "refused"));
      list.appendChild(li);
    }
    area.appendChild(list);
    var again = button("Reload");
    again.addEventListener("click", function () { location.reload(); });
    area.appendChild(again);
    area.hidden = false;
  }
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.matches || !form.matches("form[data-action]")) return;
    ev.preventDefault();
    var action = form.getAttribute("data-action") || "";
    var area = form.querySelector("[data-preview]");
    if (!/^[a-z0-9-]{1,40}$/.test(action) || !area) return;
    var body;
    try { body = bodyOf(form); } catch (e) { show(area, e.message); return; }
    show(area, "Previewing...");
    post("/api/act/" + action + "/preview", body).then(function (r) {
      if (!r.ok) { show(area, errorOf(r)); return; }
      if (r.body.unchanged) { show(area, (r.body.summary || []).join(" ") || "No change."); return; }
      var ticket = r.body.ticket;
      area.innerHTML = typeof r.body.diffHtml === "string" ? r.body.diffHtml : "";
      area.hidden = false;
      var bar = document.createElement("div");
      bar.className = "confirm";
      var yes = button("Confirm");
      var no = button("Cancel");
      bar.appendChild(yes);
      bar.appendChild(no);
      area.appendChild(bar);
      no.addEventListener("click", function () {
        area.textContent = "";
        area.hidden = true;
      });
      yes.addEventListener("click", function () {
        yes.disabled = true;
        no.disabled = true;
        post("/api/act/" + action + "/confirm", { ticket: ticket }).then(function (c) {
          if (c.ok) {
            var results = c.body && c.body.results;
            var refused = false;
            if (results && results.length) for (var i = 0; i < results.length; i++) if (results[i] && results[i].ok === false) refused = true;
            if (refused) showResults(area, results);
            else location.reload();
          } else if (c.status === 409) {
            var why = errorOf(c);
            show(area, /preview/i.test(why) ? why : why + " Preview the change again.");
          } else {
            show(area, errorOf(c));
          }
        }, function () { show(area, "The console could not be reached."); });
      });
    }, function () { show(area, "The console could not be reached."); });
  });
  var live = document.body ? document.body.getAttribute("data-live") : null;
  if (live && typeof EventSource === "function") {
    var query = document.body.getAttribute("data-query") || "";
    var status = document.getElementById("live-status");
    var mark = function (text, cls) {
      if (!status) return;
      status.textContent = text;
      status.className = cls;
    };
    var es = new EventSource("/api/events?page=" + encodeURIComponent(live) + (query ? "&" + query : ""));
    es.addEventListener("open", function () { mark("live", "on"); });
    // A refused stream (429 over the stream limit, 401 signed out) is CLOSED by the browser and never retried; only a
    // dropped one reconnects. Say which, so a still page is not mistaken for a live one.
    es.addEventListener("error", function () {
      if (es.readyState === 2) mark("not live: reload after closing another console tab", "off");
      else mark("reconnecting", "off");
    });
    es.addEventListener("panel", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.id !== "string" || typeof msg.html !== "string") return;
      var el = document.getElementById(msg.id);
      if (!el || !el.hasAttribute("data-panel")) return;
      if (inUse(el)) return;
      el.innerHTML = msg.html;
      mark("live", "on");
    });
    es.addEventListener("end", function () {
      es.close();
      mark("signed out", "off");
      location.assign("/login");
    });
  }
  // ---- the live transcript (issue #643) ----
  var tbox = document.querySelector("[data-transcript]");
  var tjob = tbox ? tbox.getAttribute("data-job") : null;
  if (tbox && tjob && typeof EventSource === "function") {
    var tstatus = document.querySelector("[data-transcript-status]");
    var tmark = function (text, cls) {
      if (!tstatus) return;
      tstatus.textContent = text;
      tstatus.className = "t-status " + cls;
    };
    var tes = new EventSource("/api/transcript?id=" + encodeURIComponent(tjob));
    tes.addEventListener("open", function () { tmark("live", "on"); });
    tes.addEventListener("error", function () {
      if (tes.readyState === 2) tmark("not live: reload after closing another console tab", "off");
      else tmark("reconnecting", "off");
    });
    tes.addEventListener("entry", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.html !== "string") return;
      // Follow the bottom only when the reader is already there: one who scrolled up to read keeps their place.
      var atBottom = tbox.scrollHeight - tbox.scrollTop - tbox.clientHeight < 24;
      tbox.insertAdjacentHTML("beforeend", msg.html);
      if (atBottom) tbox.scrollTop = tbox.scrollHeight;
      tmark("live", "on");
    });
    tes.addEventListener("done", function (ev) {
      tes.close();
      var outcome = "unknown";
      try {
        var d = JSON.parse(ev.data);
        if (d && typeof d.outcome === "string") outcome = d.outcome;
      } catch (e) { /* keep unknown */ }
      tmark("ended (" + outcome + ")", "ended");
    });
    tes.addEventListener("end", function () {
      tes.close();
      tmark("signed out", "off");
      location.assign("/login");
    });
  }
})();
`;
