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
 * Server text is shown with `textContent`, never as markup; the one `innerHTML` is the panel swap above.
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
