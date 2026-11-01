/** #774: real console/CSP/session/action interactions, with an injected host executor and zero paid work. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openChrome } from "../../launch/chrome-pipe.mjs";
import { findChrome, chromeLaunchArgs, measureSource, widthVerdict, EDGE_SLACK } from "./console-width-check.mjs";
import { startSetupBrowserFixture, SETUP_BROWSER_TOKENS } from "../../admin/test/helpers/setup-browser.mjs";
import { SECURITY_HEADERS } from "../../admin/src/console/headers.mjs";

export async function checkSetupBrowser({ chrome, shots = null, sandbox = process.env.GITHUB_ACTIONS !== "true" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "pd-setup-browser-")), children = new Set();
  let fixture, browser, tab, stage = "startup";
  const exceptions = [];
  try {
    mkdirSync(join(work, "app")); fixture = await startSetupBrowserFixture(join(work, "app"));
    mkdirSync(join(work, "chrome"));
    browser = await openChrome({ chrome, work: join(work, "chrome"), children, env: { HOME: process.env.HOME }, extraArgs: chromeLaunchArgs({ sandbox }), resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", captureStderr: true });
    assert.equal((await browser.send("Browser.getVersion")).product.split("/")[1], JSON.parse(readFileSync(new URL("../chrome-for-testing.json", import.meta.url))).version);
    tab = await browser.openTarget(); await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__setupCsp=[];addEventListener('securitypolicyviolation',e=>window.__setupCsp.push(e.violatedDirective+':'+e.blockedURI));" });
    browser.event(message => { if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text); return false; }, "diagnostics", 300000).catch(() => {});
    const evaluate = async expression => {
      const result = await tab.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async expression => {
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        try { if (await evaluate(`Boolean(${expression})`)) return; } catch (error) { if (!/context|navigat/.test(error.message)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out: ${expression}; ${await evaluate("document.querySelector('#confirm-slot')?.innerText ?? location.pathname")}`);
    };
    const navigate = async path => {
      const loaded = browser.event(message => message.sessionId === tab.sessionId && message.method === "Page.loadEventFired", "setup page load");
      const response = browser.event(message => message.sessionId === tab.sessionId && message.method === "Network.responseReceived" && message.params.type === "Document" && message.params.response.url.startsWith(fixture.origin + "/"), "setup document response");
      loaded.catch(() => {}); response.catch(() => {});
      await tab.send("Page.navigate", { url: fixture.origin + path }); await loaded;
      const headers = Object.fromEntries(Object.entries((await response).params.response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.equal(headers["content-security-policy"], SECURITY_HEADERS["content-security-policy"]);
      await until("document.readyState==='complete'");
      await evaluate("document.fonts.ready.then(()=>true)");
    };
    const click = async selector => {
      const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing click target');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!document.elementFromPoint(x,y)?.closest(${JSON.stringify(selector)}))throw Error('Obscured click target');return{x,y};})()`);
      for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    };
    const type = async (selector, text) => { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.select();})()`); await tab.send("Input.insertText", { text }); };
    const press = async (key, code, windowsVirtualKeyCode) => {
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
    };
    const expectAborted = async (signal, label) => {
      if (!signal.aborted) await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${label}: the host planner was not cancelled`)), 10_000);
        signal.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
      assert.equal(signal.aborted, true, label);
    };
    const choose = async (selector, value) => {
      const count = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();return [...el.options].filter(option=>!option.disabled).findIndex(option=>option.value===${JSON.stringify(value)});})()`);
      assert.ok(count >= 0, `the supported selector offers ${value}`);
      const target = await evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector('option[value="'+${JSON.stringify(value)}+'"]')?.textContent`);
      for (const char of target) { await tab.send("Input.dispatchKeyEvent", { type: "char", text: char }); }
      await press("Tab", "Tab", 9);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), value, "keyboard selects the requested provider/mode");
    };
    const login = async role => {
      await tab.send("Network.clearBrowserCookies"); await navigate("/login");
      await until("document.querySelector('#login-form')&&!document.querySelector('#login-form').hidden");
      await type("#token", SETUP_BROWSER_TOKENS[role]); await click("#login-form button"); await until("location.pathname==='/'");
    };
    const capture = async (name, selector = null) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true }); await evaluate("window.scrollTo(0,0)");
      const metrics = await tab.send("Page.getLayoutMetrics");
      const rect = selector ? await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};})()`) : { x: 0, y: 0, ...(metrics.cssContentSize ?? metrics.contentSize) };
      const image = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } }, 60_000);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(image.data, "base64"));
    };
    const paints = [];
    for (const role of ["operator", "viewer", "agent"]) {
      await login(role);
      for (const theme of ["light", "dark"]) for (const width of [320, 375, 390, 760, 761, 800, 1024, 1440]) {
        stage = `${role} ${theme} ${width}`;
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await navigate("/setup");
        const painted = await evaluate(`(()=>{const style=getComputedStyle(document.body);return{canvas:style.getPropertyValue('--canvas').trim(),fonts:document.fonts.status,font:style.fontFamily,css:[...document.styleSheets].some(sheet=>sheet.href?.endsWith('/static/console.css')&&sheet.cssRules.length>100),segments:document.querySelectorAll('.su-seg').length,forms:document.querySelectorAll('[data-action^="setup-"]').length,labels:[...document.querySelectorAll('.su-step__t')].map(el=>el.innerText),csp:window.__setupCsp};})()`);
        assert.equal(painted.canvas, theme === "light" ? "#edeeec" : "#000000"); assert.equal(painted.fonts, "loaded"); assert.match(painted.font, /system-ui|Arial|Segoe UI/); assert.equal(painted.css, true); assert.equal(painted.segments, 8); assert.deepEqual(painted.csp, []);
        assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true, `${stage}: complete page content must fit`);
        if (role !== "operator") { assert.equal(painted.forms, 0); assert.equal(await evaluate("document.querySelectorAll('input[type=password]').length"), 0); }
        else { assert.ok(painted.forms > 0); assert.ok(painted.labels.some(label => label.includes("worker"))); }
        paints.push({ role, theme, width, ...painted });
        if ([375, 1024, 1440].includes(width)) await capture(`setup-${role}-${theme}-${width}`);
        await navigate("/config/connections");
        const keysPaint = await evaluate(`(()=>{const style=getComputedStyle(document.body);return{canvas:style.getPropertyValue('--canvas').trim(),fonts:document.fonts.status,css:[...document.styleSheets].some(sheet=>sheet.href?.endsWith('/static/console.css')&&sheet.cssRules.length>100),forms:document.querySelectorAll('form[data-provider-key-form]').length,csp:window.__setupCsp};})()`);
        assert.equal(keysPaint.canvas, theme === "light" ? "#edeeec" : "#000000"); assert.equal(keysPaint.fonts, "loaded"); assert.equal(keysPaint.css, true); assert.deepEqual(keysPaint.csp, []);
        assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true, `${stage}: Connections sections fit`);
        assert.equal(keysPaint.forms, role === "operator" ? 1 : 0);
        if (role !== "operator") assert.equal(await evaluate("document.querySelectorAll('input[type=password], [data-provider-pick]').length"), 0);
        paints.push({ role, theme, width, page: "connections", ...keysPaint });
        if ([375, 1024, 1440].includes(width)) await capture(`provider-keys-${role}-${theme}-${width}`);
      }
    }
    await login("operator"); await navigate("/setup");
    stage = "production CSP negative control";
    await evaluate("window.__setupInjected=false;const script=document.createElement('script');script.textContent='window.__setupInjected=true';document.head.appendChild(script)");
    await until("window.__setupCsp.some(value=>value.startsWith('script-src')&&value.endsWith(':inline'))");
    assert.equal(await evaluate("window.__setupInjected"), false);
    await navigate("/setup");
    stage = "worker preview/confirm and evidence";
    await until("document.querySelector('[data-action=setup-worker-start] button')&&!document.querySelector('[data-action=setup-worker-start] fieldset').disabled");
    await click('[data-action="setup-worker-start"] button[type=submit]');
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    assert.equal(fixture.effects.length, 0, "preview never starts a worker");
    assert.match(await evaluate("document.querySelector('#confirm-slot').innerText"), /manual|queued|reserve/i);
    await click("#confirm-slot [data-confirm]");
    await until("document.querySelector('#confirm-slot').hidden || !document.querySelector('#confirm-slot [data-confirm]')");
    assert.deepEqual(fixture.effects, ["setup-worker-start"]);
    await navigate("/setup");
    await until("document.querySelector('#p-setup .su-step__t .chip.tone-running')?.textContent==='Starting'");
    for (const theme of ["light", "dark"]) for (const width of [375, 1024, 1440]) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate("/setup");
      await until("document.querySelector('#p-setup .su-step__t .chip.tone-running')?.textContent==='Starting'");
      assert.equal(await evaluate("document.querySelectorAll('#p-setup .su-seg.tone-running').length"), 1, "the actual progress bar has one blue Starting segment");
      assert.equal(await evaluate("document.querySelectorAll('[data-action=setup-worker-start]').length"), 0, "Starting renders the progress state, not the idle start controls");
      assert.match(await evaluate("document.querySelector('#p-setup .su-step [role=status]').innerText"), /Waiting for a fresh heartbeat/);
      assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true);
      await capture(`setup-starting-${theme}-${width}`);
    }
    fixture.readyWorker(); await fixture.refresh();
    await until("document.querySelector('#p-setup-ready').innerText.includes('A worker runs')");
    stage = "private key channel";
    const key = "sk-browser-private-canary-774";
    await navigate("/config/connections");
    await type('[data-action="setup-provider-key"] input[name=value]', key);
    await click('[data-action="setup-provider-key"] button[type=submit]');
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    assert.equal(await evaluate("document.querySelector('[data-action=setup-provider-key] input[name=value]').value"), "", "browser clears the write-only field at submission");
    assert.ok(!fixture.keyFile().includes(key), "preview writes no key");
    assert.equal(await evaluate(`document.querySelector('#confirm-slot').innerText.includes(${JSON.stringify(key)})`), false);
    await click("#confirm-slot [data-confirm]");
    await until("document.querySelector('#confirm-slot').hidden || !document.querySelector('#confirm-slot [data-confirm]')");
    assert.ok(fixture.keyFile().includes(key), "confirmed key reaches the injected host boundary");
    assert.ok(!JSON.stringify(fixture.logs).includes(key));
    stage = "multiple providers and separate Replace";
    const firstEnv = fixture.keyFile();
    for (const provider of ["openrouter", "deepseek"]) {
      await navigate("/config/connections");
      await choose('[data-provider-key-form] select[name=provider]', provider);
      await type('[data-provider-key-form] input[name=value]', `private-${provider}-canary-774`);
      await click('[data-provider-key-form] button[type=submit]');
      await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
      assert.match(await evaluate("document.querySelector('#confirm-slot').innerText"), new RegExp(provider));
      await click("#confirm-slot [data-confirm]");
      await until("document.querySelector('#confirm-slot').hidden || !document.querySelector('#confirm-slot [data-confirm]')");
      assert.ok(fixture.keyFile().includes(`private-${provider}-canary-774`));
      assert.ok(fixture.keyFile().includes(firstEnv.trim()), "adding another provider preserves existing credentials and the default");
    }
    await navigate("/config/connections");
    const original = fixture.keyFile();
    await click('[data-provider-pick="openrouter"][data-provider-mode="replace"]');
    assert.equal(await evaluate("document.activeElement?.name"), "value", "row shortcut focuses the new-key input");
    assert.equal(await evaluate("document.querySelector('[data-provider-key-form]').getAttribute('data-action')"), "setup-provider-key-replace");
    await type('[data-provider-key-form] input[name=value]', "replacement-openrouter-private-774");
    await click('[data-provider-key-form] button[type=submit]');
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    assert.equal(fixture.keyFile(), original, "Replace preview has no write");
    assert.match(await evaluate("document.querySelector('#confirm-slot').innerText"), /not retained for Undo/);
    assert.equal(await evaluate("document.querySelector('#confirm-slot [data-confirm]').innerText"), "Replace key");
    assert.equal(await evaluate("document.querySelector('[data-provider-key-form] input[name=value]').value"), "");
    await click("#confirm-slot [data-confirm]");
    await until("document.querySelector('#confirm-slot').hidden || !document.querySelector('#confirm-slot [data-confirm]')");
    assert.equal(fixture.keyFile(), original.replace("private-openrouter-canary-774", "replacement-openrouter-private-774"), "Replace changes only the selected key bytes");
    stage = "provider and mode changes cancel pending private input";
    await navigate("/config/connections");
    await choose('[data-provider-key-form] select[name=provider]', "openai");
    await type('[data-provider-key-form] input[name=value]', "unsubmitted-private-openai-774");
    await choose('[data-provider-key-form] select[name=provider]', "deepseek");
    assert.equal(await evaluate("document.querySelector('[data-provider-key-form] input[name=value]').value"), "", "changing provider clears an unsubmitted key");
    await type('[data-provider-key-form] input[name=value]', "unsubmitted-private-mode-774");
    await choose('[data-provider-key-form] select[data-provider-key-mode]', "replace");
    assert.equal(await evaluate("document.querySelector('[data-provider-key-form] input[name=value]').value"), "", "changing mode clears an unsubmitted key");
    await choose('[data-provider-key-form] select[data-provider-key-mode]', "add");
    await choose('[data-provider-key-form] select[name=provider]', "openai");
    const delayed = fixture.delayNextKeyPreview();
    await type('[data-provider-key-form] input[name=value]', "late-private-openai-canary-774");
    await click('[data-provider-key-form] button[type=submit]'); const delayedSignal = await delayed.started;
    await choose('[data-provider-key-form] select[name=provider]', "deepseek");
    await expectAborted(delayedSignal, "provider change aborts the real request and its private planner before it returns");
    delayed.release();
    await until("document.querySelector('#confirm-slot').hidden");
    await choose('[data-provider-key-form] select[name=provider]', "openai");
    const cancelledPlanner = fixture.delayNextKeyPreview();
    await type('[data-provider-key-form] input[name=value]', "cancel-before-plan-private-774");
    await click('[data-provider-key-form] button[type=submit]');
    const cancelledSignal = await cancelledPlanner.started;
    await click("#confirm-slot [data-cancel]");
    await expectAborted(cancelledSignal, "Cancel aborts the real private request before its planner returns");
    cancelledPlanner.release();
    await choose('[data-provider-key-form] select[name=provider]', "deepseek");
    await choose('[data-provider-key-form] select[data-provider-key-mode]', "replace");
    await type('[data-provider-key-form] input[name=value]', "cancelled-private-deepseek-774");
    await click('[data-provider-key-form] button[type=submit]');
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    const cancelledMode = browser.event(message => message.sessionId === tab.sessionId && message.method === "Network.responseReceived" && message.params.response.url.endsWith("/api/act/setup-provider-key-replace/cancel"), "mode change cancellation");
    await choose('[data-provider-key-form] select[data-provider-key-mode]', "add"); await cancelledMode;
    assert.equal(await evaluate("document.querySelector('#confirm-slot').hidden"), true);
    assert.equal(await evaluate("document.querySelector('[data-provider-key-form] input[name=value]').value"), "");
    assert.ok(!fixture.keyFile().includes("late-private") && !fixture.keyFile().includes("cancelled-private"));
    await choose('[data-provider-key-form] select[name=provider]', "openai");
    await type('[data-provider-key-form] input[name=value]', "stale-private-openai-774");
    await click('[data-provider-key-form] button[type=submit]');
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    const beforeStale = fixture.keyFile() + "PI_MAX_COST_USD=2\n";
    fixture.changeEnv(beforeStale);
    await click("#confirm-slot [data-confirm]");
    await until("document.querySelector('#confirm-slot').innerText.includes('deployment changed')");
    assert.equal(fixture.keyFile(), beforeStale, "stale confirmation preserves all current bytes");
    assert.ok(!JSON.stringify(fixture.logs).includes("private-openai"));
    stage = "navigation aborts in-flight private input";
    await navigate("/config/connections");
    await choose('[data-provider-key-form] select[name=provider]', "openai");
    const leaving = fixture.delayNextKeyPreview();
    await type('[data-provider-key-form] input[name=value]', "navigation-private-openai-774");
    await click('[data-provider-key-form] button[type=submit]');
    const plannerSignal = await leaving.started;
    await navigate("/config/connections");
    await expectAborted(plannerSignal, "navigation's actual HTTP disconnect cancels the pending private planner");
    leaving.release();
    await choose('[data-provider-key-form] select[name=provider]', "openai");
    await type('[data-provider-key-form] input[name=value]', "fresh-private-openai-774");
    await click('[data-provider-key-form] button[type=submit]');
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    assert.match(await evaluate("document.querySelector('#confirm-slot').innerText"), /OPENAI_API_KEY/);
    await click("#confirm-slot [data-cancel]");
    assert.equal(fixture.keyFile(), beforeStale, "neither abandoned nor cancelled preview writes a key");
    for (const theme of ["light", "dark"]) for (const width of [375, 1024, 1440]) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate("/config/connections");
      assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true);
      await capture(`provider-keys-configured-${theme}-${width}`, "#p-provider-keys");
      await capture(`connections-configured-${theme}-${width}`);
      await click('[data-provider-help="deepseek"] summary');
      await capture(`provider-keys-guide-${theme}-${width}`, "#p-provider-keys");
      for (const provider of ["openai", "anthropic"]) await click(`[data-subscription-help="${provider}"] summary`);
      await capture(`provider-subscription-guides-${theme}-${width}`, "#p-subscription-auth");
      stage = `special authentication guidance ${theme} ${width}`;
      await click('#p-provider-keys .pk-guide:not([data-provider-help]) > summary');
      for (const provider of ["amazon-bedrock", "google-vertex", "openai-codex"]) {
        await click(`[data-provider-help="${provider}"] summary`);
        const special = await evaluate(`(()=>{const guide=document.querySelector('[data-provider-help="${provider}"]'),option=document.querySelector('[data-provider-key-form] option[value="${provider}"]');return{open:guide.open,visible:!!guide.querySelector('.pk-notice').getClientRects().length,disabled:option.disabled,notice:guide.querySelector('.pk-notice').textContent}})()`);
        assert.equal(special.open && special.visible && special.disabled, true, "Special authentication guidance is readable while generic credential entry stays unavailable");
        assert.match(special.notice, provider === "google-vertex" ? /ADC-only.*not supported/ : /worker.*does not support/);
        await capture(`provider-special-${provider}-${theme}-${width}`, `[data-provider-help="${provider}"]`);
      }
      assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true);
      await capture(`provider-special-guides-${theme}-${width}`, "#p-provider-keys");
    }
    stage = "trigger recipe navigation and edit";
    await navigate("/setup"); await click('a[href="/config/trigger-add?recipe=comment-answer"]');
    await until("location.search==='?recipe=comment-answer'");
    assert.equal(await evaluate("document.querySelector('form[data-structured=trigger] [name=kind]').value"), "comment");
    assert.equal(await evaluate("document.querySelector('[data-trigger-kind=comment] [name=phrase]').value"), "@pi");
    await type('form[data-structured="trigger"] input[name=flow]', "review");
    await click('form[data-structured="trigger"] button[type=submit]'); await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    assert.equal(fixture.document().triggers.length, 0);
    assert.match(await evaluate("document.querySelector('#confirm-slot').innerText"), /review/);
    await click("#confirm-slot [data-confirm]"); await until("document.querySelector('#confirm-slot').hidden || !document.querySelector('#confirm-slot [data-confirm]')");
    assert.equal(fixture.document().triggers[0].run.flow, "review");
    stage = "viewer invitation private result";
    await navigate("/setup");
    await click('#p-setup-ready .card > details > summary');
    await type('[data-action="setup-viewer-add"] input[name=name]', "new-viewer");
    await click('[data-action="setup-viewer-add"] button[type=submit]'); await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    await click("#confirm-slot [data-confirm]"); await until("document.querySelector('[data-setup-invitation]')");
    const href = await evaluate("document.querySelector('[data-setup-invitation] code')?.textContent");
    assert.match(href, /\/login\/code#[A-Za-z0-9_-]{43}&next=\/setup$/);
    await capture("setup-private-viewer-invitation");
    await click("[data-setup-revoke] button[type=submit]");
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    assert.equal(await evaluate("document.querySelectorAll('[data-setup-invitation]').length"), 0, "opening Undo disposes the private link");
    assert.match(await evaluate("document.querySelector('#confirm-slot').innerText"), /Revoke viewer new-viewer/);
    assert.ok(JSON.parse(readFileSync(fixture.paths.tokensPath, "utf8")).tokens.some(token => token.name === "new-viewer"), "Undo preview does not revoke");
    await click("#confirm-slot [data-confirm]");
    await until("document.querySelector('#confirm-slot').hidden || !document.querySelector('#confirm-slot [data-confirm]')");
    assert.ok(!JSON.parse(readFileSync(fixture.paths.tokensPath, "utf8")).tokens.some(token => token.name === "new-viewer"), "fresh confirmed Undo revokes the created viewer");
    await tab.send("Page.navigate", { url: href });
    await until("document.body.innerText.includes('used, expired or unknown')");
    await navigate("/setup");
    await click('#p-setup-ready .card > details > summary');
    await type('[data-action="setup-viewer-add"] input[name=name]', "next-viewer");
    await click('[data-action="setup-viewer-add"] button[type=submit]');
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    await click("#confirm-slot [data-confirm]"); await until("document.querySelector('[data-setup-invitation] code')");
    const activeHref = await evaluate("document.querySelector('[data-setup-invitation] code').textContent");
    await tab.send("Page.navigate", { url: activeHref }); await until("location.pathname==='/setup'");
    assert.equal(await evaluate("document.querySelectorAll('[data-action^=setup-]').length"), 0, "invitation signs in as the created viewer");
    assert.equal(await evaluate("document.querySelectorAll('[data-setup-invitation]').length"), 0, "private result cannot survive the role change");
    stage = "no JavaScript";
    await login("operator"); await tab.send("Emulation.setScriptExecutionDisabled", { value: true }); await navigate("/setup");
    assert.equal(await evaluate("(()=>{const fields=[...document.querySelectorAll('form[data-action] fieldset')];return fields.length>0&&fields.every(fieldset=>fieldset.disabled)})()"), true);
    const effectsBefore = fixture.effects.length;
    await click("#p-setup .su-term summary");
    assert.equal(await evaluate("document.querySelector('#p-setup .su-term').open"), true, "terminal disclosure works without script");
    await evaluate("document.querySelector('#p-setup .su-term summary').focus()");
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until("!document.querySelector('#p-setup .su-term').open");
    assert.equal(fixture.effects.length, effectsBefore);
    await capture("setup-no-javascript");
    for (const width of [375, 1440]) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await navigate("/config/connections");
      assert.equal(await evaluate("(()=>{const form=document.querySelector('#p-provider-keys form[data-provider-key-form]'),fields=[...document.querySelectorAll('#p-provider-keys fieldset')];return !!form&&fields.length>0&&fields.every(fieldset=>fieldset.disabled)})()"), true);
      await click('[data-provider-help="deepseek"] summary');
      assert.equal(await evaluate("document.querySelector('[data-provider-help=deepseek]').open"), true);
      assert.equal(await evaluate("document.querySelector('[data-provider-help=deepseek] a').href"), "https://platform.deepseek.com/api_keys");
      await evaluate("document.querySelector('[data-provider-help=deepseek] summary').focus()");
      await press("Enter", "Enter", 13);
      await until("!document.querySelector('[data-provider-help=deepseek]').open");
      assert.equal(fixture.effects.length, effectsBefore, "native key guidance performs no host action");
      await capture(`provider-keys-no-javascript-${width}`);
    }
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
    stage = "read-only";
    const effects = fixture.effects.length;
    await fixture.close(); fixture = null; mkdirSync(join(work, "readonly"));
    fixture = await startSetupBrowserFixture(join(work, "readonly"), { readOnly: true });
    await login("operator");
    for (const theme of ["light", "dark"]) for (const width of [375, 1024, 1440]) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate("/setup");
      assert.equal(await evaluate("document.querySelectorAll('[data-action^=setup-]').length"), 0);
      assert.match(await evaluate("document.querySelector('#p-setup').innerText"), /read-only/);
      assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true);
      paints.push({ role: "read-only", theme, width });
      await capture(`setup-readonly-${theme}-${width}`);
      await navigate("/config/connections");
      assert.equal(await evaluate("document.querySelectorAll('form[data-provider-key-form], [data-provider-pick]').length"), 0);
      assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true);
      paints.push({ role: "read-only", theme, width, page: "connections" });
      await capture(`provider-keys-readonly-${theme}-${width}`);
    }
    if (shots) writeFileSync(join(shots, "capture-proof.json"), JSON.stringify(paints, null, 2));
    return { paints: paints.length, startingPaints: 6, effects, interactions: "real host preview/confirm, heartbeat readiness, multi-provider Add/Replace preservation, keyboard selectors, delayed preview cancellation, stale file refusal, recipe save, viewer invitation and fresh revoke, native no-script key guidance and read-only gates", csp: "production header and hostile-inline negative control" };
  } catch (error) { throw new Error(`Setup browser ${stage}: ${error.message}; exceptions=${JSON.stringify(exceptions)}; requests=${JSON.stringify(fixture?.logs.slice(-8))}`, { cause: error }); }
  finally {
    if (tab) await tab.close().catch(() => {});
    if (browser) { await browser.close(); browser.removeSingleton(); }
    for (const child of children) child.kill("SIGKILL");
    await fixture?.close(); rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chrome = findChrome();
  if (!chrome?.path) { if (process.argv.includes("--require")) throw new Error("Chrome is required"); console.log("SKIP: Chrome is unavailable"); }
  else { const at = process.argv.indexOf("--shots"); console.log(JSON.stringify(await checkSetupBrowser({ chrome: chrome.path, shots: at < 0 ? null : process.argv[at + 1] }))); }
}
