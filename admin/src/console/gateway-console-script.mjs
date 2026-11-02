/** Same-origin console half only; no terminal library, runtime client, cross-origin fetch or window messaging. */
export const GATEWAY_CONSOLE_SCRIPT = String.raw`
(function () {
  "use strict";
  var root = document.querySelector("[data-sandbox-gateway-mode]");
  if (!root) return;
  var mode = root.getAttribute("data-sandbox-gateway-mode"), person = null;
  // These controls belong to this one section, not the global frame whose IDs the kit reserves.
  var status = root.querySelector("#gateway-status"), form = root.querySelector("#gateway-step-up");
  var token = root.querySelector("#gateway-token"), submit = root.querySelector("#gateway-authorize");
  var params = new URLSearchParams(location.search), intent = params.get("intent");
  var key = intent ? "sandbox-gateway:" + intent : null;
  function refusal(text) { var error = new Error(text); error.public = true; return error; }
  function safeError(error) { return error && error.public ? error.message : "The launch state could not be read. Restart from Sandboxes."; }
  function say(text) { status.textContent = text; }
  function wide() { return window.innerWidth > 760; }
  function forget() { if (key) { try { sessionStorage.removeItem(key); } catch (_) {} } }
  function blocked(text) { form.hidden = true; token.value = ""; token.disabled = true; submit.disabled = true; say(text); }
  function phone() { root.querySelector("#gateway-phone").hidden = false; blocked("Use your own terminal on this screen. No browser attachment was authorized."); }
  async function request(path, options) {
    if (!["/api/whoami", "/api/sandbox-gateway/launch", "/api/sandbox-gateway/context", "/api/sandbox-gateway/authorize"].includes(path)) throw refusal("This console request is not supported. Restart from Sandboxes.");
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store", signal: controller.signal }, options));
      var data = await response.json();
      if (!response.ok) throw refusal(data.error || "The original sign-in or gateway could not be checked. Restart from Sandboxes.");
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw refusal("The console did not answer in time. No connection is retried; restart from Sandboxes.");
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function post(path, body) {
    var data = await request("/api/sandbox-gateway/" + path, { method: "POST", headers: { "content-type": "application/json", "x-console-as": person.name + "." + person.role }, body: JSON.stringify(body) });
    if (!data.ok) throw refusal(data.error || "This opening could not be authorized. Restart from Sandboxes.");
    return data;
  }
  function navigate(value, expectedOrigin, fragment) {
    var next = new URL(value);
    if (next.origin !== expectedOrigin || next.username || next.password || (!fragment && next.hash)) throw refusal("The gateway address changed. Restart from Sandboxes.");
    location.replace(next.href);
  }
  async function start() {
    // Same-origin fetch receives a Strict cookie withheld on the cross-site landing GET. Normal login would replace it.
    var allowed = mode === "launch" ? ["host", "id"] : mode === "authorize" ? ["intent"] : [];
    if ([...params.keys()].some(function (name) { return !allowed.includes(name) || params.getAll(name).length !== 1; })) throw refusal("This launch address is not usable. Restart from Sandboxes.");
    person = await request("/api/whoami", {});
    if (mode === "return") { location.replace("/runs/sandboxes"); return; }
    if (person.role !== "operator" || person.readOnly) throw refusal("Browser terminals need an operator on a writable console. Use the native terminal route.");
    if (!wide()) { phone(); return; }
    // Check storage BEFORE creating authority; private browsing/storage refusal must leave a truthful fallback.
    sessionStorage.setItem("sandbox-gateway-check", "1"); sessionStorage.removeItem("sandbox-gateway-check");
    if (mode === "launch") {
      var data = await post("launch", { host: params.get("host"), id: params.get("id"), width: window.innerWidth });
      intent = data.intentId; key = "sandbox-gateway:" + intent;
      sessionStorage.setItem(key, JSON.stringify({ proof: data.tabProof, at: Date.now(), gateway: new URL(data.launchUrl).origin }));
      navigate(data.launchUrl, new URL(data.launchUrl).origin, true);
      return;
    }
    if (!intent || !/^[A-Za-z0-9_-]{43}$/.test(intent)) throw refusal("This opening has no original-tab proof. Restart from Sandboxes.");
    var saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!saved || Object.keys(saved).sort().join() !== "at,gateway,proof" || !/^[A-Za-z0-9_-]{43}$/.test(saved.proof) || !Number.isSafeInteger(saved.at) || typeof saved.gateway !== "string" || new URL(saved.gateway).origin !== saved.gateway || !/^https?:/.test(saved.gateway) || Date.now() - saved.at >= 300000 || Date.now() < saved.at) { forget(); throw refusal("This opening expired or belongs to another tab. Restart from Sandboxes."); }
    var context = await post("context", { intentId: intent, tabProof: saved.proof });
    if (context.gatewayOrigin !== saved.gateway) { forget(); throw refusal("Gateway enrollment changed. Restart from Sandboxes."); }
    root.querySelector("#gateway-target").textContent = context.id + " on " + context.host;
    root.querySelector("#gateway-person").textContent = "Verify as " + context.by + " before attaching through " + context.gatewayOrigin + ".";
    root.querySelector("#gateway-details").hidden = false;
    form.hidden = false; token.disabled = false; submit.disabled = false;
    say("Enter this sign-in's current operator token. The one-use attachment grant lasts 60 seconds.");
    token.focus();
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!wide()) { phone(); return; }
      submit.disabled = true;
      say("Verifying this sign-in and sandbox. Nothing opens until the check succeeds.");
      var value = token.value; token.value = "";
      try {
        var result = await post("authorize", { intentId: intent, tabProof: saved.proof, token: value, width: window.innerWidth });
        value = ""; forget(); saved.proof = "";
        navigate(result.returnUrl, saved.gateway, false);
      } catch (error) { value = ""; say(safeError(error)); submit.disabled = false; token.focus(); }
    });
  }
  window.addEventListener("resize", function () { if (!wide() && mode !== "return") phone(); });
  start().catch(function (error) { blocked(safeError(error)); });
})();
`;
