/** #773: real files, Valkey observations, authenticated HTTP, production CSP and reviewed role-map writes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openChrome } from "../../launch/chrome-pipe.mjs";
import { findChrome, chromeLaunchArgs } from "./console-width-check.mjs";
import { startModelsBrowserFixture, MODELS_BROWSER_TOKENS, MODEL_REFS } from "../../admin/test/helpers/models-browser.mjs";
import { SECURITY_HEADERS } from "../../admin/src/console/headers.mjs";
import { consoleSubscriptionFixture } from "../../admin/test/helpers/subscription-auth-fixture.mjs";
import { makeSubscriptionQuotaStore, normalizeClaudeQuota } from "../../worker/src/subscription-quota.mjs";

export async function checkModelsBrowser({ chrome, shots = null, sandbox = process.env.GITHUB_ACTIONS !== "true" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "pd-models-browser-")), children = new Set();
  let fixture, browser, tab, paints = 0, stage = "startup";
  const subscriptionStyleChecks = [], sessionCookies = new Map();
  try {
    mkdirSync(join(work, "app")); fixture = await startModelsBrowserFixture(join(work, "app"));
    mkdirSync(join(work, "browser"));
    browser = await openChrome({ chrome, work: join(work, "browser"), children, env: { HOME: process.env.HOME }, extraArgs: chromeLaunchArgs({ sandbox }), resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", captureStderr: true });
    assert.equal((await browser.send("Browser.getVersion")).product.split("/")[1], JSON.parse(readFileSync(new URL("../chrome-for-testing.json", import.meta.url))).version);
    tab = await browser.openTarget();
    await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__modelsCsp=[];window.__modelsReplies=[];window.__modelsClipboard=null;const originalClipboardWrite=navigator.clipboard?.writeText?.bind(navigator.clipboard);if(originalClipboardWrite)navigator.clipboard.writeText=async value=>{await originalClipboardWrite(value);window.__modelsClipboard=value;};addEventListener('securitypolicyviolation',e=>window.__modelsCsp.push(e.violatedDirective+':'+e.blockedURI));const originalFetch=window.fetch;window.fetch=async(...args)=>{const response=await originalFetch(...args);if(String(args[0]).includes('/api/act/')){const body=await response.clone().json();window.__modelsReplies.push({url:String(args[0]),status:response.status,body});}return response;};" });
    const evaluate = async expression => {
      const result = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (predicate, label) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        try { if (await predicate()) return; } catch (error) { if (!/context|navigat/.test(error.message)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error(`Timed out: ${label}`);
    };
    const until = expression => waitFor(() => evaluate(`Boolean(${expression})`), expression);
    const navigate = async path => {
      const loaded = browser.event(message => message.sessionId === tab.sessionId && message.method === "Page.loadEventFired", "Models load");
      const response = browser.event(message => message.sessionId === tab.sessionId && message.method === "Network.responseReceived" && message.params.type === "Document" && message.params.response.url.startsWith(fixture.origin + "/"), "Models document");
      loaded.catch(() => {}); response.catch(() => {});
      await tab.send("Page.navigate", { url: fixture.origin + path }); await loaded;
      const headers = Object.fromEntries(Object.entries((await response).params.response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.equal(headers["content-security-policy"], SECURITY_HEADERS["content-security-policy"]);
      await until("document.readyState==='complete'"); await evaluate("document.fonts.ready.then(()=>true)");
    };
    const click = async selector => {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('No click target '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!document.elementFromPoint(x,y)?.closest(${JSON.stringify(selector)}))throw Error('Click target obscured');return{x,y};})()`);
      await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    };
    const type = async (selector, text) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();})()`); await tab.send("Input.insertText", { text }); };
    const key = async (key, code, windowsVirtualKeyCode) => { for (const type of ["keyDown", "keyUp"]) await tab.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, ...(type === "keyDown" && key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) }); };
    const login = async role => {
      await tab.send("Network.clearBrowserCookies");
      const cacheKey = `${fixture.origin}:${role}`;
      if (sessionCookies.has(cacheKey)) {
        await tab.send("Network.setCookies", { cookies: sessionCookies.get(cacheKey) });
        await navigate("/models"); return;
      }
      await navigate("/login");
      await until("document.querySelector('#login-form')&&!document.querySelector('#login-form').hidden");
      await type("#token", MODELS_BROWSER_TOKENS[role]); await click("#login-form button");
      await until("location.pathname==='/'");
      const cookies = (await tab.send("Network.getCookies", { urls: [fixture.origin] })).cookies;
      sessionCookies.set(cacheKey, cookies.map(({ name, value, domain, path, httpOnly, secure, sameSite }) => ({ name, value, domain, path, httpOnly, secure, ...(sameSite ? { sameSite } : {}) })));
      await navigate("/models");
    };
    const post = async (action, operation, body) => evaluate(`fetch(${JSON.stringify(`/api/act/${action}/${operation}`)},{method:'POST',headers:{'content-type':'application/json','x-console-as':document.querySelector('.who').dataset.name+'.'+document.querySelector('.who').dataset.role},body:JSON.stringify(${JSON.stringify(body)})}).then(async response=>({status:response.status,body:await response.json()}))`);
    const capture = async (name, selector = null) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true }); await evaluate("window.scrollTo(0,0)");
      const metrics = await tab.send("Page.getLayoutMetrics"), size = metrics.cssContentSize ?? metrics.contentSize;
      const clip = selector ? await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()`) : { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      const shot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip }, 60000);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(shot.data, "base64"));
    };
    const paint = async ({ role, width, theme, readOnly = false, name = "models" }) => {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate("/models");
      const actual = await evaluate(`(()=>{const style=getComputedStyle(document.body);return{width:document.scrollingElement.scrollWidth,canvas:style.getPropertyValue('--canvas').trim(),fonts:document.fonts.status,font:style.fontFamily,css:[...document.styleSheets].some(s=>s.href?.endsWith('/static/console.css')&&s.cssRules.length>100),headings:[...document.querySelectorAll('h2')].map(e=>e.textContent),forms:document.querySelectorAll('form[data-action="model-role-edit"]').length,commands:document.querySelector('#p-proposals')?.textContent.includes('pi-dispatch canary'),csp:window.__modelsCsp,more:document.querySelector('details.more')?.textContent,current:document.querySelector('details.more summary')?.getAttribute('aria-current'),text:document.querySelector('main').textContent};})()`);
      assert.ok(actual.width <= width + 1, `${name} ${role} ${theme} ${width}: page wider than viewport (${actual.width})`);
      assert.equal(actual.canvas, theme === "light" ? "#edeeec" : "#000000"); assert.equal(actual.fonts, "loaded"); assert.match(actual.font, /system-ui|Arial|Segoe UI/); assert.equal(actual.css, true); assert.deepEqual(actual.csp, []);
      for (const title of ["Model roles", "Cooling down", "Models in use", "Proposals and canaries"]) assert.ok(actual.headings.includes(title), title);
      if (role === "operator" && !readOnly) assert.ok(actual.forms > 0); else { assert.equal(actual.forms, 0); assert.equal(actual.commands, false); }
      assert.ok(actual.more.includes("Models")); assert.equal(actual.more.includes("Audit"), role === "operator");
      if (width <= 760) {
        const cells = await evaluate(`(()=>{const visible=e=>!!e.getClientRects().length;return [...document.querySelectorAll('#p-roles .tbl--stack td[data-l],#p-proposals .tbl--stack td[data-l]')].filter(visible).map(cell=>({label:cell.dataset.l,width:cell.getBoundingClientRect().width,row:cell.closest('tr').getBoundingClientRect().width,labelDisplay:getComputedStyle(cell,'::before').display}));})()`);
        for (const cell of cells) {
          assert.ok(cell.width >= cell.row * 0.8, `${name} ${width}: ${cell.label} is squeezed to ${cell.width}px in ${cell.row}px row`);
          assert.equal(cell.labelDisplay, "block", `${name} ${width}: ${cell.label} must sit above its full-width value`);
        }
      }
      if (name === "models") { assert.ok(actual.text.includes("$0.24")); assert.ok(actual.text.includes("$0.06")); assert.ok(actual.text.includes("120,000")); assert.ok(actual.text.includes("140,000")); }
      await capture(`${name}-${role}${readOnly ? "-readonly" : ""}-${theme}-${width}`); paints++;
    };

    stage = "read roles, themes and complete sections";
    for (const role of ["operator", "viewer", "agent"]) {
      await login(role);
      for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) await paint({ role, width, theme });
      if (role !== "operator") {
        const denied = await post("model-role-edit", "preview", { scope: "default", role: "editor", model: MODEL_REFS.candidate });
        assert.equal(denied.status, 403);
      }
    }

    stage = "subscription facts, role restrictions, phone field widths and actual CSP";
    const subscriptionClock = fixture.state.subscriptionAuth.now;
    const subscriptionPaint = async ({ page, role, width, theme, readOnly = false, name = "subscription" }) => {
      const panel = page === "connections" ? "p-subscription-auth" : "p-subscription-quota";
      stage = `${name} ${page} ${role} ${theme} ${width}`;
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate(page === "connections" ? "/config/connections" : "/models");
      const state = await evaluate(`(()=>{const panel=document.querySelector('#${panel}');if(!panel)throw Error('Missing subscription panel: '+location.pathname+' '+document.body.textContent.slice(-1600));const style=getComputedStyle(document.body),visible=e=>!!e.getClientRects().length;return{text:panel.textContent,width:document.scrollingElement.scrollWidth,canvas:style.getPropertyValue('--canvas').trim(),fonts:document.fonts.status,font:style.fontFamily,ink:style.getPropertyValue('--ink').trim(),css:[...document.styleSheets].some(s=>s.href?.endsWith('/static/console.css')&&s.cssRules.length>100),commands:panel.querySelectorAll('.sa-account .sa-commands .cmd').length,forms:panel.querySelectorAll('form').length,csp:window.__modelsCsp,facts:[...panel.querySelectorAll('.sa-facts dd')].filter(visible).map(e=>({width:e.getBoundingClientRect().width,parent:e.parentElement.getBoundingClientRect().width,text:e.textContent,overflow:e.scrollWidth>e.clientWidth+1})),glyphs:[...panel.querySelectorAll('.badge')].every(e=>e.querySelector('svg use')),badges:[...panel.querySelectorAll('.badge')].map(e=>{const box=e.getBoundingClientRect(),lines=[...e.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).flatMap(n=>{const r=document.createRange();r.selectNodeContents(n);return[...r.getClientRects()]});return{word:e.textContent,inside:lines.every(r=>r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1)}}),links:[...panel.querySelectorAll('a')].map(e=>e.getAttribute('href'))};})()`);
      assert.ok(state.width <= width + 1, `${name} ${page} ${width}: viewport width`);
      assert.equal(state.canvas, theme === "light" ? "#edeeec" : "#000000"); assert.equal(state.fonts, "loaded"); assert.equal(state.css, true); assert.deepEqual(state.csp, []); assert.equal(state.glyphs, true);
      for (const badge of state.badges) assert.equal(badge.inside, true, `${name}: ${badge.word} text must fit its complete badge`);
      assert.equal(state.forms, 0, "Subscription sign-in has no browser authentication mutation");
      assert.equal(state.commands > 0, role === "operator" && !readOnly);
      assert.ok(state.text.includes("claude-work")); assert.ok(state.text.includes("mini1"));
      assert.ok(state.links.includes("/fleet/host?name=mini1"));
      if (page === "connections" && role === "agent") assert.ok(await evaluate("document.querySelector('#p-connection-problems').textContent.includes('Limited Connections view')&&!document.querySelector('#p-connection-problems').textContent.includes('could not read')"));
      if (page === "connections") { assert.ok(state.text.includes("pi-anthropic-oauth@0.3.6")); assert.ok(state.text.includes("Pinned artifact verified; job checks remain")); assert.ok(state.text.includes("not a successful paid request")); }
      else { assert.ok(state.text.includes("100% used") && state.text.includes("42% used")); assert.ok(state.text.includes("deployment dollar windows still apply")); assert.ok(state.text.includes("Not authorized for paid overage")); }
      for (const fact of state.facts) {
        assert.equal(fact.overflow, false, `${name}: ${fact.text} must fit its field`);
        if (width <= 600) assert.ok(fact.width >= fact.parent * 0.95 && fact.width >= 180, `${name}: ${fact.text} squeezed to ${fact.width}px in ${fact.parent}px`);
      }
      subscriptionStyleChecks.push({ page, role, readOnly, width, theme, canvas: state.canvas, ink: state.ink, font: state.font, fonts: state.fonts, sharedStylesheet: state.css, fieldWidths: state.facts });
      await capture(`${name}-${page}-${role}${readOnly ? "-readonly" : ""}-${theme}-${width}`);
      if (role === "operator" && !readOnly) await capture(`${name}-${page}-card-${theme}-${width}`, `#${panel} .card`);
      paints++;
    };
    for (const role of ["operator", "viewer", "agent"]) {
      await login(role);
      for (const page of ["connections", "models"]) for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) await subscriptionPaint({ page, role, width, theme });
    }
    stage = "maximum valid connection and owner names keep every command and text line readable";
    await login("operator");
    const longId = "a".repeat(64), longHost = "h".repeat(64);
    fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock, value => { Object.assign(value.connections[0], { id: longId, ownerHost: longHost, adapter: "@gotgenes/pi-anthropic-auth@3.4.3" }); });
    for (const page of ["connections", "models"]) for (const theme of ["light", "dark"]) for (const width of [320, 375, 390, 768, 1440]) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate(page === "connections" ? "/config/connections" : "/models");
      const panel = page === "connections" ? "p-subscription-auth" : "p-subscription-quota";
      const result = await evaluate(`(()=>{const panel=document.querySelector('#${panel}'),card=panel.querySelector('.card').getBoundingClientRect(),visible=e=>!!e.getClientRects().length;return{width:document.scrollingElement.scrollWidth,text:panel.textContent,commands:[...panel.querySelectorAll('.sa-account .sa-commands .cmd code')].map(e=>e.textContent),owner:panel.querySelector('.sa-account .sa-facts a[href^="/fleet/host?"]')?.getAttribute('href'),ownerText:panel.querySelector('.sa-account .sa-facts a[href^="/fleet/host?"]')?.textContent,guides:[...panel.querySelectorAll('.pk-guide a')].map(e=>e.getAttribute('href')),csp:window.__modelsCsp,boxes:[...panel.querySelectorAll('.sa-title h3,.sa-facts dd,.sa-note,.sa-commands > div,.sa-commands .cmd,.sa-commands code')].filter(visible).map(e=>{const r=e.getBoundingClientRect(),walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),lines=[];while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const line of range.getClientRects())lines.push({left:line.left,right:line.right,top:line.top,bottom:line.bottom});}return{text:e.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom,cardLeft:card.left,cardRight:card.right,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,ellipsis:getComputedStyle(e).textOverflow,lines};})}})()`);
      assert.ok(result.width <= width + 1, `${page} ${theme} ${width}: maximum valid names must fit the viewport`);
      assert.ok(result.text.includes(longId) && result.text.includes(longHost), "The complete accepted identifiers remain present");
      assert.equal(result.owner, `/fleet/host?name=${longHost}`);
      assert.equal(result.ownerText, longHost, "The account owner link retains the complete accepted host identifier");
      if (page === "connections") assert.ok(result.guides.includes("https://github.com/edgehero/pi-dispatch/blob/main/docs/subscription-auth.md"), "Host guides coexist with the account owner and exact account commands");
      assert.equal(result.commands.length, page === "connections" ? 3 : 1);
      assert.ok(result.commands.every(command => command.endsWith(longId)), "Every complete copy command retains the full connection identifier");
      assert.deepEqual(result.csp, []);
      for (const box of result.boxes) {
        assert.ok(box.left >= box.cardLeft - 1 && box.right <= box.cardRight + 1, `${page} ${width}: ${box.text} expands its card`);
        assert.ok(box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1, `${page} ${width}: ${box.text} requires hidden scrolling`);
        assert.notEqual(box.ellipsis, "ellipsis");
        assert.ok(box.lines.length > 0 && box.lines.every(line => line.left >= box.left - 1 && line.right <= box.right + 1 && line.top >= box.top - 1 && line.bottom <= box.bottom + 1), `${page} ${width}: every rendered line of ${box.text} must fit its own box`);
      }
      subscriptionStyleChecks.push({ name: "maximum-valid-names", page, theme, width, boxes: result.boxes.length, renderedLines: result.boxes.reduce((count, box) => count + box.lines.length, 0), completeCommands: result.commands });
      await capture(`subscription-long-${page}-${theme}-${width}`);
      await capture(`subscription-long-${page}-card-${theme}-${width}`, `#${panel} .card`); paints++;
    }
    fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock);
    stage = "subscription keyboard Copy writes the exact terminal command";
    await login("operator"); await navigate("/config/connections");
    const originalSubscription = JSON.stringify(fixture.state.subscriptionAuth), originalReplies = await evaluate("window.__modelsReplies.length");
    await browser.send("Browser.grantPermissions", { origin: fixture.origin, permissions: ["clipboardSanitizedWrite"] });
    await until("document.querySelector('#p-subscription-auth .sa-account .sa-commands [data-copy]').getClientRects().length>0");
    await evaluate("document.querySelector('#p-subscription-auth .sa-account .sa-commands [data-copy]').focus()"); await key("Enter", "Enter", 13);
    await until("document.querySelector('#p-subscription-auth .sa-account .sa-commands [data-copy]').textContent==='Copied'");
    assert.equal(await evaluate("window.__modelsClipboard"), "pi-dispatch auth login claude-work");
    assert.equal(JSON.stringify(fixture.state.subscriptionAuth), originalSubscription, "Copying sign-in changes no credential or observation");
    assert.equal(await evaluate("window.__modelsReplies.length"), originalReplies, "Copy makes no authentication request");

    stage = "monitoring focus cannot hide authoritative weekly exhaustion";
    let quotaClock = subscriptionClock;
    const quota = makeSubscriptionQuotaStore({ redis: fixture.redis, now: () => quotaClock });
    const identity = { connectionId: "claude-work", owner: "mini1", accountDigest: "12345678-1234-1234-1234-123456789abc", bucket: "anthropic:subscription", generation: 1 };
    for (const weeklyUsed of [42, 100]) {
      const observation = normalizeClaudeQuota({ five_hour: { utilization: 12, resets_at: new Date(quotaClock + 5 * 3_600_000).toISOString() }, seven_day: { utilization: weeklyUsed, resets_at: new Date(quotaClock + 7 * 86_400_000).toISOString() }, extra_usage: { is_enabled: false } }, { observedAt: quotaClock });
      const recorded = await quota.record(identity, observation);
      assert.equal(recorded.ok, true);
      const admitted = await quota.admit(identity, { windows: ["five-hour"], consumeTrial: false, requireExtraUsageKnownDisabled: true });
      assert.equal(admitted.ok, weeklyUsed < 100, "The actual Valkey admission still enforces an excluded exhausted week");
      if (weeklyUsed >= 100) { assert.equal(admitted.reason, "subscription-quota"); assert.equal(admitted.until, quotaClock + 7 * 86_400_000); }
      fixture.state.subscriptionAuth = consoleSubscriptionFixture(quotaClock, value => { value.connections[0].quotaWindows = ["five-hour"]; value.connections[0].quota = recorded.status; });
      for (const width of [390, 1440]) {
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: width === 390 ? "dark" : "light" }] });
        await navigate("/models");
        const observed = await evaluate("(()=>{const e=document.querySelector('#p-subscription-quota');return{text:e.textContent,rows:[...e.querySelectorAll('.sa-window')].map(row=>row.textContent),width:document.scrollingElement.scrollWidth}})()");
        assert.ok(observed.width <= width && observed.text.includes("Five-hour account window") && observed.text.includes("12% used"));
        if (weeklyUsed < 100) { assert.equal(observed.rows.length, 1); assert.ok(!observed.text.includes("42% used") && !observed.text.includes("Seven-day account window")); }
        else {
          assert.equal(observed.rows.length, 2); assert.ok(observed.text.includes("Seven-day account window") && observed.text.includes("100% used"));
          assert.ok(observed.text.includes("Required exhaustion evidence outside the monitoring focus"));
          assert.ok(observed.text.includes(`Waiting until ${new Date(admitted.until).toISOString().replace("T", " ").slice(0, 19)} UTC`));
        }
        await capture(`subscription-models-focus-${weeklyUsed < 100 ? "five-hour" : "mandatory-week"}-${width}`);
        await capture(`subscription-models-focus-${weeklyUsed < 100 ? "five-hour" : "mandatory-week"}-card-${width}`, "#p-subscription-quota .card"); paints++;
      }
      quotaClock++; fixture.advance(1);
    }

    stage = "subscription stale, unknown-reset trial and exceptional account status";
    fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock, value => { value.connections[0].quota.observedAt -= 600_000; });
    await navigate("/models"); assert.ok(await evaluate("document.querySelector('#p-subscription-quota').textContent.includes('Exhaustion retained')"));
    assert.ok(await evaluate("document.querySelector('#p-subscription-quota').textContent.includes('Stale or freshness unknown')"));
    await capture("subscription-models-stale");
    fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock, value => { Object.assign(value.connections[0].quota, { blockedUnknownReset: true, until: null, trialAvailable: false }); value.connections[0].quota.windows[0].resetAt = null; });
    await navigate("/models");
    assert.ok(await evaluate("document.querySelector('#p-subscription-quota').textContent.includes('Exhausted; reset unknown')"));
    assert.ok(await evaluate("document.querySelector('#p-subscription-quota').textContent.includes('pi-dispatch auth trial claude-work')"));
    assert.ok(await evaluate("document.querySelector('#p-subscription-quota').textContent.includes('does not clear account exhaustion or start a job here')"));
    await capture("subscription-models-unknown-reset");
    fixture.state.subscriptionAuth.connections[0].quota.trialAvailable = true;
    await navigate("/models");
    assert.ok(await evaluate("(()=>{const t=document.querySelector('#p-subscription-quota').textContent;return t.includes('One trial is authorized; other pickup gates still apply')&&t.includes('One quota trial is already authorized')&&!t.includes('pi-dispatch auth trial')})()"));
    await capture("subscription-models-trial-authorized");
    fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock, value => { value.connections[0].quota = null; value.connections[0].state = "refresh-uncertain"; value.connections[0].compatibility = "conflicting"; });
    await navigate("/config/connections");
    assert.ok(await evaluate("document.querySelector('#p-subscription-auth').textContent.includes('Refresh outcome uncertain')&&document.querySelector('#p-subscription-auth').textContent.includes('Conflicting provider overrides')"));
    await capture("subscription-connections-refresh-conflict");
    await navigate("/models");
    assert.ok(await evaluate("(()=>{const t=document.querySelector('#p-subscription-quota').textContent;return t.includes('Usage unknown')&&t.includes('Reset unknown')&&!t.includes('0% used')&&!t.includes('Quota observed available')})()"));
    await capture("subscription-models-unknown");
    stage = "both adapter families and precise compatibility states";
    for (const [adapter, provider, kind] of [["openai-chatgpt", "openai", "pi-dispatch built-in"], ["@gotgenes/pi-anthropic-auth@3.4.3", "anthropic", "community"]]) {
      fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock, value => { Object.assign(value.connections[0], { adapter, provider }); });
      for (const theme of ["light", "dark"]) for (const width of [320, 1440]) {
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await navigate("/config/connections");
        const result = await evaluate("(()=>{const e=document.querySelector('#p-subscription-auth');return{text:e.textContent,width:document.scrollingElement.scrollWidth,fields:[...e.querySelectorAll('dd')].map(x=>({width:x.getBoundingClientRect().width,overflow:x.scrollWidth>x.clientWidth+1}))}})()");
        assert.ok(result.text.includes(adapter) && result.text.includes(provider) && result.text.includes(kind));
        assert.ok(result.width <= width && result.fields.every(field => !field.overflow && (width > 600 || field.width >= 180)));
        await capture(`subscription-adapter-${provider}-${theme}-${width}`); paints++;
      }
    }
    for (const [compatibility, words] of [["disabled", "Extension disabled"], ["unstaged", "Extension not staged"], ["unpinned", "Exact version not pinned"], ["version-mismatch", "Adapter version mismatch"], ["unavailable", "Adapter unavailable"]]) {
      fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock, value => { Object.assign(value.connections[0], { compatibility, state: "adapter-unavailable" }); });
      await navigate("/config/connections");
      assert.ok(await evaluate(`document.querySelector('#p-subscription-auth').textContent.includes(${JSON.stringify(words)})`));
    }
    fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock, value => { value.partial = true; });
    await navigate("/config/connections");
    assert.ok(await evaluate("document.querySelector('#p-subscription-auth').textContent.includes('Partial subscription observations')"));
    await capture("subscription-connections-partial");
    fixture.state.subscriptionAuth = { state: "ready", partial: false, connections: [] };
    await navigate("/config/connections");
    assert.ok(await evaluate("document.querySelector('#p-subscription-auth').textContent.includes('No subscription connection is configured')"));
    fixture.state.subscriptionAuth = null;
    await navigate("/config/connections");
    assert.ok(await evaluate("document.querySelector('#p-subscription-auth').textContent.includes('Subscription status not published')&&!document.querySelector('#p-subscription-auth').textContent.includes('No subscription connection is configured')"));
    await capture("subscription-connections-unpublished");
    fixture.state.subscriptionAuth = consoleSubscriptionFixture(subscriptionClock);
    stage = "subscription no-JavaScript facts and terminal instructions";
    for (const role of ["operator", "viewer", "agent"]) {
      await login(role); await tab.send("Emulation.setScriptExecutionDisabled", { value: true });
      for (const page of ["connections", "models"]) {
        await navigate(page === "connections" ? "/config/connections" : "/models");
        const panel = page === "connections" ? "p-subscription-auth" : "p-subscription-quota";
        assert.ok(await evaluate(`(()=>{const e=document.querySelector('#${panel}');return e.textContent.includes('claude-work')&&e.textContent.includes('pi-dispatch auth')===${role === "operator"}&&[...e.querySelectorAll('[data-copy]')].every(b=>b.hidden)&&!e.querySelector('form')})()`));
        await capture(`subscription-${page}-${role}-no-javascript`);
      }
      await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
    }
    await login("operator");
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate("/models");
    const original = fixture.document();
    stage = "native Edit, keyboard preview, exact diff and persistence";
    await click('[data-model-edit="md-editor-row-0"]');
    assert.deepEqual(fixture.document(), original, "Opening Edit changes no file");
    await type("#md-row-0-model", MODEL_REFS.candidate);
    await evaluate("document.querySelector('#md-row-0-model').closest('form').querySelector('button[type=submit]').focus()");
    await key("Enter", "Enter", 13);
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    assert.deepEqual(fixture.document(), original, "Preview changes no file");
    const preview = await evaluate("document.querySelector('#confirm-slot').textContent");
    assert.ok(preview.includes("modelRoles")); assert.ok(preview.includes("next delivery")); assert.match(preview, /recovery/i);
    const first = await evaluate("window.__modelsReplies.find(r=>r.url.endsWith('/preview')&&r.body.ticket)?.body");
    await capture("models-edit-preview");
    await click("#confirm-slot [data-confirm]");
    await waitFor(() => fixture.document().modelRoles.default.editor?.model === MODEL_REFS.candidate, "confirmed role write");
    assert.deepEqual(fixture.document().triggers, original.triggers);
    assert.deepEqual(fixture.document().modelRoles.web, original.modelRoles.web);
    assert.equal(fixture.pickup("editor").model, "gpt-4o"); assert.equal(fixture.pickup("editor").provider, "openai");
    await until("document.querySelector('form.undo')");
    assert.equal((await post("model-role-edit", "confirm", { ticket: first.ticket })).status, 409, "A used confirm ticket cannot write again");
    await capture("models-edit-saved");
    stage = "reviewed Undo restores original representation";
    await click("form.undo button"); await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    await click("#confirm-slot [data-confirm]"); await waitFor(() => JSON.stringify(fixture.document()) === JSON.stringify(original), "Undo file restoration");

    stage = "Adopt prefill and bound canary numbers";
    await navigate("/models"); await click(".md-adopt summary");
    assert.deepEqual(fixture.document(), original);
    assert.equal(await evaluate("document.querySelector('#md-canary-0-scope').value"), "", "Adopt cannot infer project scope");
    await evaluate("(()=>{const e=document.querySelector('#md-canary-0-scope');e.value='default';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await click(".md-adopt button[type=submit]");
    await until("document.querySelector('#confirm-slot [data-confirm]')&&!document.querySelector('#confirm-slot [data-confirm]').disabled");
    const adoption = await evaluate("document.querySelector('#confirm-slot').textContent");
    assert.ok(adoption.includes("0.240000") && adoption.includes("0.060000"), "Confirm repeats trusted source/candidate cost");
    await capture("models-adopt-preview"); await click("#confirm-slot [data-cancel]");
    assert.deepEqual(fixture.document(), original);
    const sample = (await fixture.modelsView()).canaries[0];
    const adoptBody = { scope: "default", role: sample.role, model: sample.candidate, canary: { role: sample.role, candidate: sample.candidate, flow: sample.flow, digest: sample.digest } };
    const staleCanary = await post("model-role-edit", "preview", adoptBody);
    assert.equal(staleCanary.status, 200);
    const changedRecord = fixture.records.get(sample.rows[0].jobId), beforeCost = changedRecord.tokens.cost;
    changedRecord.tokens.cost = 0.07;
    assert.equal((await post("model-role-edit", "confirm", { ticket: staleCanary.body.ticket })).status, 409, "Changed actual canary metrics invalidate confirmation");
    assert.equal((await post("model-role-edit", "preview", adoptBody)).status, 409, "Stale displayed comparison needs a reload");
    changedRecord.tokens.cost = beforeCost;
    assert.deepEqual(fixture.document(), original);

    stage = "stale file, expired ticket and unknown model refusals";
    const fresh = await post("model-role-edit", "preview", { scope: "default", role: "reviewer", model: MODEL_REFS.candidate });
    assert.equal(fresh.status, 200); assert.ok(fresh.body.ticket);
    fixture.saveDocument({ ...original, modelRoles: { ...original.modelRoles, default: { ...original.modelRoles.default, auxiliary: MODEL_REFS.fallback } } });
    const stale = await post("model-role-edit", "confirm", { ticket: fresh.body.ticket }); assert.equal(stale.status, 409);
    fixture.saveDocument(original);
    const expires = await post("model-role-edit", "preview", { scope: "default", role: "reviewer", model: MODEL_REFS.candidate });
    fixture.advance(300001); assert.equal((await post("model-role-edit", "confirm", { ticket: expires.body.ticket })).status, 409);
    const invalid = await post("model-role-edit", "preview", { scope: "default", role: "reviewer", model: "openai/definitely-not-a-real-model-773" });
    assert.ok(invalid.status >= 400); assert.deepEqual(fixture.document(), original);

    stage = "no-JavaScript facts, native menu and disabled writes";
    await tab.send("Emulation.setScriptExecutionDisabled", { value: true }); await navigate("/models");
    assert.ok(await evaluate("[...document.querySelectorAll('form[data-action] fieldset')].every(e=>e.disabled)"));
    await click("details.more summary"); assert.equal(await evaluate("document.querySelector('details.more').open"), true);
    assert.ok(await evaluate("document.querySelector('a[href=\"/models\"]')!==null"));
    await capture("models-no-javascript");
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false }); await navigate("/models");
    stage = "keyboard More and CSP negative control";
    await evaluate("document.querySelector('details.more summary').focus()"); await key("Enter", "Enter", 13);
    assert.equal(await evaluate("document.querySelector('details.more').open"), true); await key("Escape", "Escape", 27);
    assert.equal(await evaluate("document.querySelector('details.more').open"), false);
    assert.equal(await evaluate("document.activeElement===document.querySelector('details.more summary')"), true);
    await evaluate("(()=>{const e=document.createElement('div');e.setAttribute('style','color:red');document.body.append(e);})()");
    await until("window.__modelsCsp.length>0");
    assert.ok((await evaluate("window.__modelsCsp")).every(value => value.startsWith("style-src")));
    assert.ok(fixture.verifyAudit().ok); assert.ok(!(await fixture.redis.keys("bull:*" )).length, "Editing roles never enqueues work");

    await fixture.close(); fixture = null;
    for (const variant of [{ name: "models-readonly", readOnly: true }, { name: "models-empty", empty: true }, { name: "models-long", longNames: true }]) {
      stage = variant.name; mkdirSync(join(work, variant.name)); fixture = await startModelsBrowserFixture(join(work, variant.name), variant);
      await login("operator");
      for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) await paint({ role: "operator", width, theme, readOnly: variant.readOnly, name: variant.name });
      if (variant.readOnly) {
        for (const page of ["connections", "models"]) for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) await subscriptionPaint({ page, role: "operator", width, theme, readOnly: true, name: "subscription-readonly" });
      }
      if (variant.readOnly) assert.equal((await post("model-role-edit", "preview", { scope: "default", role: "editor", model: MODEL_REFS.candidate })).status, 403);
      if (variant.empty) assert.ok(await evaluate("document.querySelector('main').textContent.includes('No model roles')"));
      if (variant.longNames) for (const value of fixture.records.values()) assert.ok(await evaluate(`document.body.textContent.includes(${JSON.stringify(value.jobId)})`), "Full long run labels remain present");
      if (variant.longNames) {
        await tab.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
        await navigate("/models"); await click('[data-model-edit="md-editor-row-0"]');
        const button = await evaluate("(()=>{const e=document.querySelector('#md-editor-row-0 .md-remove button'),r=e.getBoundingClientRect(),card=e.closest('.card').getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);return{text:e.textContent,left:r.left,right:r.right,cardLeft:card.left,cardRight:card.right,height:r.height,width:document.scrollingElement.scrollWidth,lines:[...range.getClientRects()].map(line=>({left:line.left,right:line.right})),ellipsis:getComputedStyle(e).textOverflow};})()");
        assert.ok(button.text.includes("e".repeat(32)), "The longest accepted role is drawn completely");
        assert.ok(button.left >= button.cardLeft && button.right <= button.cardRight, "The complete removal control fits its phone card");
        assert.ok(button.lines.length && button.lines.every(line => line.left >= button.left - 1 && line.right <= button.right + 1), "Every rendered line of the removal label fits its control");
        assert.notEqual(button.ellipsis, "ellipsis");
        assert.ok(button.width <= 320); await capture("models-long-edit-dark-320");
      }
      await fixture.close(); fixture = null;
    }
    if (shots) writeFileSync(join(shots, "subscription-style-checks.json"), `${JSON.stringify(subscriptionStyleChecks, null, 2)}\n`);
    return { ok: true, paints, subscription: "safe roles, complete phone fields, quota/staleness/trial counterexamples, real clipboard write, no-JavaScript facts", csp: "production header and negative control", writes: "preview, confirm, undo, stale, expired and role/read-only refusals" };
  } catch (error) { error.stack = `Models browser (${stage}): ${error.stack}`; throw error; }
  finally {
    await tab?.close().catch(() => {});
    if (browser) { await browser.close(); browser.removeSingleton(); }
    for (const child of children) child.kill("SIGKILL");
    await fixture?.close(); rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = findChrome(), chrome = typeof found === "string" ? found : found?.path;
  const shots = process.argv.indexOf("--shots");
  checkModelsBrowser({ chrome, shots: shots >= 0 ? process.argv[shots + 1] : null }).then(result => console.log(JSON.stringify(result)), error => { console.error(error.stack); process.exitCode = 1; });
}
