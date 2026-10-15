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
 *   - the spend screen's chart tooltips: the insights renderers mark each bar with `data-tip="<n>"` and the page lists
 *     the texts in `#insights-tips` (escaped by the server). Each marked element gets its text as an SVG `<title>`
 *     child (or a `title` attribute off SVG), set through `textContent`, so a tooltip is the browser's own and no
 *     markup is built here.
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
 * Server text is shown with `textContent`, never as markup; the two `innerHTML` writes are the panel swap and the
 * preview swap above, both of server-escaped fragments into elements the server marked for them.
 */
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
  var SVG_NS = "http://www.w3.org/2000/svg";
  function applyTips() {
    var list = document.getElementById("insights-tips");
    if (!list) return;
    var items = list.getElementsByTagName("li");
    var marked = document.querySelectorAll("[data-tip]");
    for (var k = 0; k < marked.length; k++) {
      var el = marked[k];
      var i = parseInt(el.getAttribute("data-tip"), 10);
      // The index rides an attribute, so it is bounds-checked before it is used; a bad one is skipped.
      if (!(i >= 0 && i < items.length)) continue;
      var text = items[i].textContent;
      if (el.namespaceURI === SVG_NS) {
        var t = document.createElementNS(SVG_NS, "title");
        t.textContent = text;
        el.appendChild(t);
      } else {
        el.setAttribute("title", text);
      }
    }
  }
  applyTips();
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
})();
`;
