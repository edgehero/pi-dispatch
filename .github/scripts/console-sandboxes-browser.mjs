/** #771: real browser interactions against the actual console routes, guards, script, CSS and CSP. Zero paid work. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openChrome } from "../../launch/chrome-pipe.mjs";
import { EDGE_SLACK, chromeLaunchArgs, findChrome, measureSource, widthVerdict } from "./console-width-check.mjs";
import { parseSandboxOpenUrl } from "../../worker/src/opener-protocol.mjs";
import { startSandboxBrowserFixture, SANDBOX_BROWSER_TOKENS } from "../../admin/test/helpers/sandbox-browser.mjs";
import { SECURITY_HEADERS } from "../../admin/src/console/headers.mjs";

export async function checkSandboxBrowser({ chrome, shots = null, sandbox = process.env.GITHUB_ACTIONS !== "true" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "pd-sandbox-browser-")), children = new Set();
  let fixture, extraFixture, browser, tab, keeperAbort, keeperReader, stage = "startup";
  try {
    fixture = await startSandboxBrowserFixture(work);
    mkdirSync(join(work, "browser"));
    browser = await openChrome({ chrome, work: join(work, "browser"), children, env: { HOME: process.env.HOME }, extraArgs: chromeLaunchArgs({ sandbox }), resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", captureStderr: true });
    tab = await browser.openTarget(); await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__sandboxCsp=[]; addEventListener('securitypolicyviolation',e=>window.__sandboxCsp.push(e.violatedDirective+':'+e.blockedURI));" });
    const evaluate = async (expression) => {
      let r;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { r = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); break; }
        catch (error) { if (!/navigated|context|closed/.test(error.message) || attempt === 19) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + r.exceptionDetails.exception?.description);
      return r.result.value;
    };
    const until = async (expression) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(expression + " failed: " + await evaluate("JSON.stringify({url:location.href,slot:document.querySelector(\"#confirm-slot\")?.innerText,focus:document.activeElement?.outerHTML.slice(0,300)})"));
    };
    const navigate = async (path) => {
      const loaded = browser.event((m) => m.sessionId === tab.sessionId && m.method === "Page.loadEventFired", "sandbox page load");
      const response = browser.event((m) => m.sessionId === tab.sessionId && m.method === "Network.responseReceived" && m.params.type === "Document" && m.params.response.url.startsWith(fixture.origin + "/") && new URL(m.params.response.url).pathname === path.split("?")[0], "sandbox document response");
      loaded.catch(() => {}); response.catch(() => {});
      await tab.send("Page.navigate", { url: fixture.origin + path }); await loaded;
      const headers = Object.fromEntries(Object.entries((await response).params.response.headers).map(([name, value]) => [name.toLowerCase(), value]));
      assert.equal(headers["content-security-policy"], SECURITY_HEADERS["content-security-policy"], "the actual document response carries the production CSP");
      await until(`location.origin === ${JSON.stringify(fixture.origin)} && location.pathname === ${JSON.stringify(path.split("?")[0])} && document.readyState === 'complete'`);
      if (stage !== "no JavaScript") await evaluate("document.fonts.ready.then(()=>true)");
    };
    const click = async (selector) => {
      const rect = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit?.closest(${JSON.stringify(selector)}))throw Error('click target obscured by '+hit?.tagName);return {x,y};})()`);
      for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, ...rect, button: "left", clickCount: 1 });
    };
    const type = async (selector, text) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();})()`); await tab.send("Input.insertText", { text }); };
    const login = async (role) => {
      await navigate("/login"); await until("document.querySelector('#login-form') && !document.querySelector('#login-form').hidden");
      await type("#token", SANDBOX_BROWSER_TOKENS[role]); await click("#login-form button"); await until("location.pathname === '/'");
    };
    const shot = async (name) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      await evaluate("window.scrollTo(0,0)");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const metrics = await tab.send("Page.getLayoutMetrics");
      const box = metrics.cssContentSize ?? metrics.contentSize;
      assert.ok(box.width > 0 && box.width <= 2000 && box.height > 0 && box.height < 30000, `${name}: sensible complete-page capture bounds ${JSON.stringify(box)}`);
      // An explicit page clip also captures correctly after a confirm has scrolled to its action card.
      const r = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: box.width, height: box.height, scale: 1 } }, 60_000);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(r.data, "base64"));
    };
    await login("operator");
    const path = "/runs/sandboxes?id=gh-9575&host=mini1&repo=acme/web&index=0&ref=HEAD";
    stage = "CSP negative control";
    await navigate(path);
    await evaluate("window.__sandboxInlineRan=false;const probe=document.createElement('script');probe.textContent='window.__sandboxInlineRan=true';document.head.appendChild(probe)");
    await until("window.__sandboxCsp.some(x=>x.startsWith('script-src')&&x.endsWith(':inline'))");
    assert.equal(await evaluate("window.__sandboxInlineRan"), false, "the real policy blocks an inline script instead of merely carrying an unused header");
    await navigate(path); // A fresh document clears the intentional violation before positive interactions.
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 390, 760, 761, 800, 1024, 1440, 1600]) {
      stage = `render ${theme} ${width}`;
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate(path);
      await until("document.querySelector('[data-action=sandbox-prepare]')");
      const m = await evaluate(`(()=>{const b=getComputedStyle(document.body);const links=[...document.querySelectorAll('a[href^="pi-dispatch-open:"]')];return {width:document.documentElement.scrollWidth,canvas:b.getPropertyValue('--canvas').trim(),fontReady:document.fonts.status,font:b.fontFamily,cardRadius:getComputedStyle(document.querySelector('.card')).borderRadius,links:links.map(a=>({href:a.href,visible:a.getClientRects().length>0})),csp:window.__sandboxCsp};})()`);
      assert.ok(m.width <= width + 1, `Sandboxes ${theme} ${width} overflowed to ${m.width}`);
      assert.equal(m.canvas, theme === "light" ? "#edeeec" : "#000000"); assert.equal(m.fontReady, "loaded"); assert.equal(m.cardRadius, width <= 760 ? "22px" : "26px"); assert.deepEqual(m.csp, []);
      const factWidths = await evaluate("[...document.querySelectorAll('.fact dd')].filter(e=>e.textContent.trim()).map(e=>e.getBoundingClientRect().width)");
      assert.ok(factWidths.every((w) => w >= 80), `Sandboxes ${width}: readable fact values, minimum ${Math.min(...factWidths)}px`);
      assert.ok(m.links.length >= 3); for (const link of m.links) { parseSandboxOpenUrl(link.href); assert.equal(link.visible, width > 760); }
      if (width <= 760) {
        await evaluate("document.querySelector('a[href^=\"pi-dispatch-open:\"]').focus()");
        assert.equal(await evaluate("document.activeElement?.matches('a[href^=\"pi-dispatch-open:\"]')"), false, "phone opener is unfocusable");
      }
      measurements.push({ theme, width, ...m });
      if ([375, 1024, 1440].includes(width)) await shot(`sandboxes-${theme}-${width}`);
    }
    const exceptional = ["long-names", "failed", "pending", "preparing", "ready", "refused", "unknown"];
    const originalId = fixture.inventory.hosts[0].rows[0].id;
    const longId = "gh-" + "a".repeat(190), requestId = "sb-" + "e".repeat(32);
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 1024, 1440]) for (const state of exceptional) {
      stage = `exception ${state} ${theme} ${width}`;
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      fixture.inventory.hosts[0].rows[0].id = state === "long-names" ? longId : originalId;
      fixture.requests.set(requestId, { id: requestId, host: "mini1", state, ...(state === "ready" ? { result: { id: requestId, host: "mini1", backend: "local", until: fixture.inventory.hosts[0].rows[0].until, pinned: false } } : state === "refused" ? { message: "The host's image, size, venue, egress or retention changed; preview the sandbox again." } : {}) });
      fixture.advance();
      await navigate(state === "long-names" ? `/runs/sandboxes?${new URLSearchParams({ id: longId, host: "mini1", repo: "owner/" + "repository-with-a-long-name-".repeat(5), index: "0", ref: "HEAD" })}` : `/runs/sandboxes?${new URLSearchParams({ id: originalId, host: "mini1", request: requestId })}`);
      const identifier = state === "long-names" ? longId : requestId;
      const identifierSelector = state === "long-names" ? "#p-sb-kept a.code" : "#p-sb-run .banner__s .code";
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(identifierSelector)})?.textContent`), identifier, "the complete identifier remains visible, without shortening the counterexample");
      const measured = await evaluate(measureSource(width, EDGE_SLACK));
      const verdict = widthVerdict(measured, width);
      assert.equal(verdict.ok, true, `${stage}: ${JSON.stringify(verdict)}`);
      assert.deepEqual(await evaluate("window.__sandboxCsp"), []);
      if ([320, 375].includes(width) || state === "long-names" && width === 1024) await shot(`sandboxes-${state}-${theme}-${width}`);
    }
    fixture.inventory.hosts[0].rows[0].id = originalId;
    fixture.advance();
    if (shots) {
      for (const theme of ["light", "dark"]) for (const width of [375, 1024, 1440]) {
        stage = `companion captures ${theme} ${width}`;
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        for (const [name, url] of [["run", "/run?id=gh-9575"], ["host", "/fleet/host?name=mini1"]]) {
          await navigate(url); await until(name === "host" ? "document.querySelector('[data-sandbox-target]')" : "document.querySelector('[data-sandbox-command]')");
          if (name === "run") {
            const widths = await evaluate("[...document.querySelectorAll('.fact dd')].filter(e=>e.textContent.trim()).map(e=>e.getBoundingClientRect().width)");
            assert.ok(widths.every((w) => w >= 80), `Run ${width}: readable fact values, minimum ${Math.min(...widths)}px`);
          } else {
            const command = await evaluate("(()=>{const e=document.querySelector('[data-sandbox-target] .cmd code');return {text:e.textContent,width:e.getBoundingClientRect().width,scroll:e.scrollWidth}})()");
            assert.equal(command.text, "pi-dispatch opener install --config sandbox-hosts.json");
            assert.ok(command.scroll <= command.width + 1, `Host ${width}: the complete opener setup command wraps inside its card`);
          }
          assert.deepEqual(await evaluate("window.__sandboxCsp"), []);
          await shot(`${name}-${theme}-${width}`);
        }
      }
    }
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    stage = "live GET drafts";
    const streamReady = browser.event((m) => m.sessionId === tab.sessionId && m.method === "Network.responseReceived" && m.params.response.url.startsWith(fixture.origin + "/api/events?page=sandboxes"), "sandbox live stream connected");
    await navigate(path); await streamReady;
    const originalImage = fixture.inventory.hosts[0].settings.image;
    // Response headers precede the first applied panel. Prove that application before retaining field identities.
    fixture.inventory.hosts[0].settings.image = "pi-job:initial-sse-ready";
    await fixture.refresh();
    await until("document.querySelector('#p-sb-new')?.innerText.includes('pi-job:initial-sse-ready')");
    await evaluate("window.__sbRef=document.querySelector('#sb-ref');window.__sbRepo=document.querySelector('#sb-repo')");
    await type("#sb-repo", "acme/draft"); await type("#sb-ref", "feature/draft");
    fixture.inventory.hosts[0].settings.image = "pi-job:live-refresh";
    await fixture.refresh();
    await until("document.querySelector('#p-sb-new .held')");
    assert.deepEqual(await evaluate("({ref:document.querySelector('#sb-ref').value,repo:document.querySelector('#sb-repo').value,sameRef:window.__sbRef===document.querySelector('#sb-ref'),sameRepo:window.__sbRepo===document.querySelector('#sb-repo'),focus:document.activeElement===window.__sbRef})"), { ref: "feature/draft", repo: "acme/draft", sameRef: true, sameRepo: true, focus: true });
    await click("#p-sb-kept h2");
    assert.equal(await evaluate("window.__sbRef===document.querySelector('#sb-ref') && document.querySelector('#sb-ref').value==='feature/draft'"), true, "dirty draft survives leaving its field");
    await shot("sandboxes-live-held");
    await type("#sb-repo", "acme/web"); await type("#sb-ref", "HEAD"); await click("#p-sb-kept h2");
    await until("!document.querySelector('#p-sb-new .held') && document.querySelector('#p-sb-new').innerText.includes('pi-job:live-refresh')");
    assert.equal(await evaluate("window.__sbRef===document.querySelector('#sb-ref')"), false, "reverted unfocused draft takes the newest actual SSE panel");
    // Set a real native option and its input/change events, like selectOption in browser drivers. Driving
    // the operating system's popup through CDP is platform dependent; the following GET remains a real click.
    const workspace = await evaluate("(()=>{const e=document.querySelector('#sb-workspace');window.__sbWorkspace=e;e.focus();e.value=[...e.options].find(o=>o.value.startsWith('sb-')).value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()");
    assert.notEqual(workspace, "gh-9575", "another native option is selected before applying it");
    const pickedWorkspace = fixture.inventory.hosts[0].rows.find((r) => r.id === workspace);
    assert.ok(pickedWorkspace);
    const originalWorkspaceImage = fixture.inventory.hosts[0].rows[0].image;
    fixture.inventory.hosts[0].rows[0].image = "pi-job:picker-live-refresh";
    pickedWorkspace.image = "pi-job:reviewed-workspace";
    await fixture.refresh(); await until("document.querySelector('#p-sb-run .held')");
    assert.equal(await evaluate("window.__sbWorkspace===document.querySelector('#sb-workspace') && document.activeElement===window.__sbWorkspace"), true, "live update preserves the focused native picker");
    assert.equal(await evaluate("document.querySelector('#sb-workspace').value"), workspace);
    await click("#p-sb-kept h2");
    assert.equal(await evaluate("window.__sbWorkspace===document.querySelector('#sb-workspace')"), true, "unapplied select choice remains held after blur");
    const reviewedWorkspace = `new URLSearchParams(location.search).get('id')===${JSON.stringify(workspace)} && document.querySelector('#p-sb-run')?.innerText.includes('pi-job:reviewed-workspace')`;
    const documentGate = fixture.holdWorkspaceDocument(workspace);
    try {
      await click("#p-sb-run form[method=get] button");
      await until(`new URLSearchParams(location.search).get('id')===${JSON.stringify(workspace)} && document.readyState==='loading' && !document.querySelector('#p-sb-run')`);
      const response = await documentGate.started;
      assert.equal(response.status, 200); assert.equal(response.csp, SECURITY_HEADERS["content-security-policy"]);
      assert.equal(await evaluate(`Boolean(${reviewedWorkspace})`), false, "the exact destination predicate waits while its real document is still parsing");
    } finally { documentGate.release(); }
    await until(reviewedWorkspace);
    assert.equal(fixture.effects.queued.length, 0, "reviewing GET choices dispatches no host work");
    fixture.inventory.hosts[0].settings.image = originalImage;
    fixture.inventory.hosts[0].rows[0].image = originalWorkspaceImage;
    fixture.advance();
    await navigate(path);
    stage = "preparation";
    await type("#sb-ref", "pr:42"); await click("#p-sb-new form[method=get] button");
    await until("location.search.includes('pr%3A42') && document.querySelector('[data-action=sandbox-prepare]')");
    assert.equal(await evaluate("document.querySelector('[data-action=sandbox-prepare] input[name=ref]').value"), "pr:42");
    await click("[data-action=sandbox-prepare] button"); await until("document.querySelector('[data-confirm]') && !document.querySelector('[data-confirm]').disabled");
    assert.equal(fixture.effects.queued.length, 0, "Preview did not prepare or start a shell");
    await click("[data-cancel]"); assert.equal(fixture.effects.queued.length, 0);
    await click("[data-action=sandbox-prepare] button"); await until("document.querySelector('[data-confirm]') && !document.querySelector('[data-confirm]').disabled");
    // An actual keyboard Enter confirms the focused button; the single-use ticket prevents double dispatch.
    await evaluate("document.querySelector('[data-confirm]').focus()");
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await until("location.search.includes('request=sb-')"); await until("document.body.innerText.includes('is ready')");
    assert.equal(fixture.effects.queued.length, 1); assert.equal(fixture.effects.queued[0].ref, "pr:42"); assert.equal(fixture.effects.queued[0].host, "mini1");
    await shot("sandboxes-prepared");
    stage = "End";
    await navigate(path); await click("[data-action=sandbox-end] button"); await until("document.querySelector('[data-confirm]') && !document.querySelector('[data-confirm]').disabled");
    assert.equal(fixture.effects.ended.length, 0); await click("[data-confirm]"); await until("!document.querySelector('[data-action=sandbox-end]')");
    assert.equal(fixture.effects.ended.length, 1); assert.equal(fixture.effects.ended[0].nonce, "1".repeat(32));
    stage = "Fleet settings";
    await navigate("/fleet/host?name=mini1"); await until("document.querySelector('[data-action=sandbox-host-set]')");
    await type("#sb-target-target", "ops@mini1-new"); await click("[data-action=sandbox-host-set] button"); await until("document.querySelector('[data-confirm]') && !document.querySelector('[data-confirm]').disabled");
    assert.equal(fixture.service.hosts().config.hosts.mini1.target, "ops@mini1"); await click("[data-confirm]"); await until("document.querySelector('#sb-target-target')?.value === 'ops@mini1-new'");
    assert.equal(fixture.service.hosts().config.hosts.mini1.target, "ops@mini1-new");
    await navigate("/fleet/host?name=mini1"); await until("document.querySelector('#sb-target-target')?.value === 'ops@mini1-new'"); await shot("host-target-saved");
    const state = await evaluate("fetch('/api/state').then(r=>r.text())"); assert.doesNotMatch(state, /sandboxHosts|sandbox:shell|\"nonce\"|ops@mini1-new/);
    assert.deepEqual(await evaluate("window.__sandboxCsp"), []);
    stage = "incomplete registrations and cleanup warnings";
    // Keep a second authenticated stream subscribed to an old empty view. Freezing only periodic ticks
    // makes the old replay deterministic; subscribe-triggered and explicitly requested ticks still run.
    await fixture.pauseTicks();
    const cookies = await tab.send("Network.getCookies", { urls: [fixture.origin] });
    const cookie = cookies.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    keeperAbort = new AbortController();
    const keeperSignal = AbortSignal.any([keeperAbort.signal, AbortSignal.timeout(15000)]);
    const warm = await fetch(fixture.origin + "/api/events?page=sandboxes&as=ops.operator&" + path.split("?")[1], { headers: { cookie, accept: "text/event-stream" }, signal: keeperSignal });
    assert.equal(warm.status, 200);
    keeperReader = warm.body.getReader();
    let warmText = "";
    while (!warmText.includes('"id":"p-sb-open"')) {
      const part = await keeperReader.read();
      assert.equal(part.done, false, "the second real stream remains subscribed to the warm view");
      warmText += new TextDecoder().decode(part.value);
    }
    assert.match(warmText, /No live sandbox shell was registered/);
    fixture.inventory.sessionsMore = 12; fixture.inventory.sessionsUnreadable = 2; fixture.inventory.noticesUnavailable = true;
    fixture.inventory.notices = [{ host: "mini1", id: "gh-9575", at: fixture.inventory.hosts[0].at, reason: "network-kept" }];
    // Deliberately do not advance the clock: both the view and its five-second data cache are warm.
    const freshDocument = await fetch(fixture.origin + path, { headers: { cookie } }).then((r) => r.text());
    assert.match(freshDocument, /network was kept/);
    const firstOpen = browser.event((m) => m.sessionId === tab.sessionId && m.method === "Network.eventSourceMessageReceived" && m.params.eventName === "panel" && JSON.parse(m.params.data).id === "p-sb-open", "first new Sandboxes shell panel");
    const streamResponse = browser.event((m) => m.sessionId === tab.sessionId && m.method === "Network.responseReceived" && m.params.response.url.startsWith(fixture.origin + "/api/events?page=sandboxes"), "new primary Sandboxes subscription");
    firstOpen.catch(() => {}); streamResponse.catch(() => {});
    await navigate(path);
    const firstFrame = await firstOpen;
    assert.equal(keeperSignal.aborted, false, "the old view is still held by the second stream when the first primary frame arrives");
    assert.equal(firstFrame.params.requestId, (await streamResponse).params.requestId, "the first panel belongs to the new primary subscription");
    assert.match(JSON.parse(firstFrame.params.data).html, /network was kept.*incomplete.*No readable shell/s, "the FIRST stream panel must preserve fresh HTTP facts; a later repair cannot excuse stale replay");
    await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    assert.match(await evaluate("document.querySelector('#p-sb-open').innerText"), /network was kept.*incomplete.*No readable shell/s);
    assert.equal(await evaluate("document.querySelectorAll('#p-sb-open [data-action=sandbox-end]').length"), 0);
    assert.deepEqual(await evaluate("window.__sandboxCsp"), []);
    assert.equal(keeperSignal.aborted, false, "the keeper survived the complete stale-replay counterexample");
    keeperAbort.abort(); await keeperReader.cancel().catch(() => {}); keeperReader = null; keeperAbort = null;
    await shot("sandboxes-cleanup-warning");
    // Native GET selectors and selectable commands survive with the application script disabled.
    stage = "no JavaScript";
    await tab.send("Emulation.setScriptExecutionDisabled", { value: true }); await navigate(path);
    assert.equal(await evaluate("document.querySelector('[data-copy]').hidden"), true);
    assert.match(await evaluate("document.body.innerText"), /require JavaScript/);
    await type("#sb-ref", "feature/no-js"); await click("#p-sb-new form[method=get] button"); await until("location.search.includes('feature%2Fno-js')");
    assert.equal(fixture.effects.queued.length, 1); await shot("sandboxes-no-javascript");
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
    stage = "read-only";
    const writableFixture = fixture;
    mkdirSync(join(work, "readonly")); extraFixture = await startSandboxBrowserFixture(join(work, "readonly"), { readOnly: true }); fixture = extraFixture;
    await login("operator"); await navigate(path); assert.equal(await evaluate("document.querySelectorAll('[data-action]').length"), 0); await shot("sandboxes-readonly");
    await extraFixture.close(); extraFixture = null; fixture = writableFixture;
    stage = "viewer";
    await login("viewer"); await navigate("/runs"); assert.equal(await evaluate("!!document.querySelector('a[href=\"/runs/sandboxes\"]')"), false);
    await navigate("/runs/sandboxes"); assert.match(await evaluate("document.body.innerText"), /operator/i); assert.doesNotMatch(await evaluate("document.body.innerText"), /gh-9575|ops@mini1/); await shot("sandboxes-viewer-denied");
    for (const url of ["/api/sandbox-hosts", "/api/events?page=sandboxes&as=watcher.viewer"]) assert.equal(await evaluate(`fetch(${JSON.stringify(url)}).then(r=>r.status)`), 403);
    assert.equal(fixture.effects.queued.length, 1);
    return { measurements, exceptionalRenders: exceptional.length * 8, queued: fixture.effects.queued.length, ended: fixture.effects.ended.length };
  } catch (error) { throw new Error(`Sandbox browser ${stage}: ${error.message}; effects ${JSON.stringify({queued:fixture?.effects.queued.length,ended:fixture?.effects.ended.length,requests:fixture?.effects.logs.slice(-10)})}`, { cause: error }); } finally {
    keeperAbort?.abort(); await keeperReader?.cancel().catch(() => {});
    if (tab) await tab.close().catch(() => {}); if (browser) { await browser.close(); browser.removeSingleton(); }
    for (const child of children) child.kill("SIGKILL"); await fixture?.close(); if (extraFixture && extraFixture !== fixture) await extraFixture.close(); rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chrome = findChrome();
  if (!chrome?.path) { if (process.argv.includes("--require")) throw new Error("Chrome is required"); console.log("SKIP: Chrome is unavailable"); }
  else { const at = process.argv.indexOf("--shots"), out = await checkSandboxBrowser({ chrome: typeof chrome === "string" ? chrome : chrome.path, shots: at < 0 ? null : process.argv[at + 1] }); console.log(`Sandbox browser: ${out.measurements.length} responsive/theme renders, ${out.exceptionalRenders} exceptional renders, real preview/confirm, preparation, End, Fleet settings, role isolation and no-JavaScript GET passed.`); }
}
