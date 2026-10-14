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
 *   - `home`: the sign-out button.
 * Server text is shown with `textContent`, never as markup.
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
  } else if (page === "home") {
    var out = document.getElementById("logout");
    if (out) out.addEventListener("click", function () {
      post("/logout", {}).then(function () { location.assign("/login"); }, function () { location.assign("/login"); });
    });
  }
})();
`;
