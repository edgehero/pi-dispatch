/** #775: production publication/read/render path, keyboard, no-script and real CSP. No paid work. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openChrome } from "../../launch/chrome-pipe.mjs";
import { findChrome, chromeLaunchArgs, measureSource, widthVerdict, EDGE_SLACK } from "./console-width-check.mjs";
import { startConnectionsBrowserFixture, CONNECTIONS_BROWSER_TOKENS, CONNECTIONS_SLICES } from "../../admin/test/helpers/connections-browser.mjs";
import { SECURITY_HEADERS } from "../../admin/src/console/headers.mjs";

/** Text geometry is separate from page overflow: a clipping card can keep the page narrow while hiding a name. */
export function receiverIdentityProblems(evidence, { name, width }) {
  const problems = [];
  if (evidence.text !== name) problems.push("The complete receiver identity was lost");
  if (evidence.href !== `/fleet/host?name=${encodeURIComponent(name)}`) problems.push("The receiver identity link names another host");
  const rect = (r) => r && [r.left, r.right, r.top, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top;
  const chars = evidence.characters;
  if (!rect(evidence.header) || !rect(evidence.clip) || !Array.isArray(chars) || chars.length !== name.length) problems.push("Receiver identity character geometry is incomplete");
  else if (chars.some((r) => !rect(r) || r.left < Math.max(evidence.header.left, evidence.clip.left) - 1 || r.right > Math.min(evidence.header.right, evidence.clip.right) + 1 || r.top < Math.max(evidence.header.top, evidence.clip.top) - 1 || r.bottom > Math.min(evidence.header.bottom, evidence.clip.bottom) + 1)) problems.push("Receiver identity characters are clipped or outside their container");
  if (!Number.isFinite(evidence.pageWidth) || evidence.pageWidth > width + 1) problems.push("The receiver identity widens the page");
  return problems;
}

const RECEIVER_IDENTITY = `(()=>{const a=document.querySelector('.cn-receivers a[href]'),header=a.closest('h3')??a.closest('p'),box=r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}),range=document.createRange();range.selectNodeContents(a);const clip={left:0,right:innerWidth,top:-Number.MAX_SAFE_INTEGER,bottom:Number.MAX_SAFE_INTEGER},clipping=[];for(let e=a;e;e=e.parentElement){const s=getComputedStyle(e),r=e.getBoundingClientRect();if(/^(hidden|clip|auto|scroll)$/.test(s.overflowX)){clip.left=Math.max(clip.left,r.left+e.clientLeft);clip.right=Math.min(clip.right,r.left+e.clientLeft+e.clientWidth);clipping.push({tag:e.tagName,cls:e.className,axis:'x',...box(r)});}if(/^(hidden|clip|auto|scroll)$/.test(s.overflowY)){clip.top=Math.max(clip.top,r.top+e.clientTop);clip.bottom=Math.min(clip.bottom,r.top+e.clientTop+e.clientHeight);}}const characters=[];for(let i=0;i<a.firstChild.length;i++){const r=document.createRange();r.setStart(a.firstChild,i);r.setEnd(a.firstChild,i+1);characters.push(box(r.getBoundingClientRect()));}const s=getComputedStyle(a);return{text:a.textContent,href:a.getAttribute('href'),header:box(header.getBoundingClientRect()),clip,clipping,characters,rawText:box(range.getBoundingClientRect()),rawLines:[...range.getClientRects()].map(box),font:s.font,fontSize:parseFloat(s.fontSize),fonts:document.fonts.status,canvas:getComputedStyle(document.body).getPropertyValue('--canvas').trim(),css:[...document.styleSheets].some(t=>t.href?.endsWith('/static/console.css')&&t.cssRules.length>100),pageWidth:document.scrollingElement.scrollWidth,csp:window.__connectionsCsp??[],errors:window.__connectionsErrors??[]};})()`;

export function connectionsEvidenceProblems(evidence, { slice, width, theme, receiverPort, unauthorized = 2, absent = false } = {}) {
  const problems = [];
  const require = (condition, reason) => { if (!condition) problems.push(reason); };
  require(evidence.canvas === (theme === "light" ? "#edeeec" : "#000000"), "The theme's shared canvas is absent");
  require(evidence.fonts === "loaded" && /system-ui|Arial|Segoe UI/.test(evidence.font), "The native font stack has not loaded");
  require(evidence.css === true && evidence.cardRadius >= 10, "The shared card stylesheet is absent");
  require(evidence.width <= width + 1, "The complete page exceeds its viewport");
  require(evidence.csp.length === 0, "The page violated its CSP");
  if (slice === "receiver" || slice === "hooks" || slice === "all") {
    if (absent && slice !== "hooks") require(/no live receiver|not reported/i.test(evidence.forges), "Receiver deletion did not become unreported");
    else {
      require(evidence.unauthorized === String(unauthorized), "The actual unauthorized count is wrong");
      require(evidence.receiverPort === String(receiverPort), "The actual listening port is wrong");
      require(evidence.links.includes("/fleet/host?name=mini1"), "The receiver host link is wrong");
      require(/check the webhook secret on both sides/i.test(evidence.problems + evidence.forges), "Unauthorized-only traffic has no actionable warning");
      require(evidence.receiverTimes > 0, "Receiver times were not rendered as times");
    }
  }
  if (slice === "hooks" || slice === "all") {
    if (absent) require(/no hook run published/i.test(evidence.notify), "Hook deletion did not become unreported");
    else {
      require(evidence.hookCounts.exit === 1 && evidence.hookCounts.timeout === 1, "Retained hook detail counts are wrong");
      require(evidence.links.includes("/run?id=gh-timeout-775"), "The last hook run link is wrong");
      require(evidence.hookAttention.includes("timeout"), "The hook timeout lost its text and warning tint");
      require(evidence.hookTimes > 0, "The hook time was not rendered as a time");
      require(evidence.hookWordsOk === true, "Hook host identities or header words are squeezed into fragments");
      require(evidence.hookScrollOk === true, "An overflowing hook table is not keyboard accessible");
    }
  }
  if (slice === "endpoints" || slice === "all") {
    if (absent) require(/occupancy not reported/i.test(evidence.endpoints), "Endpoint deletion did not become unreported");
    else {
      require(evidence.hostSlots["local-model:mini1"] === "1 of 2", "Per-machine host usage is wrong");
      require(evidence.hostSlots["shared-model:mini2"] === "2 of 3", "The second host's usage or declaration is wrong");
      require(evidence.hostSlots["shared-model:build3"] === "1 of 4", "An unnamed host's local usage was lost");
      require(evidence.localScope === true, "The per-machine endpoint claims a fleet bound");
      require(evidence.endpointWordsOk === true, "Endpoint key words are squeezed into fragments");
      require(/one server, one id/i.test(evidence.endpoints), "Conflicting shared-server slot declarations have no warning");
    }
  }
  return problems;
}

const EVIDENCE = `(()=>{const text=id=>document.querySelector(id)?.innerText??'',f=document.querySelector('#p-forges'),n=document.querySelector('#p-notify'),ep=document.querySelector('#p-endpoints'),s=getComputedStyle(document.body),tables=[...document.querySelectorAll('table')],outcome=tables.find(t=>t.getAttribute('aria-label')==='mini1 github delivery outcomes'),unauthorized=[...(outcome?.tBodies[0]?.rows??[])].find(r=>r.cells[0].textContent.trim()==='unauthorized'),receiver=document.querySelector('[aria-label="Receiver on mini1"]'),port=receiver?.textContent.match(/(?:port[: ]+)([0-9]+)/i)?.[1]??null,hook=tables.find(t=>t.getAttribute('aria-label')==='Failure hook runs'),hostSlots={};for(const list of document.querySelectorAll('ul[aria-label$=" host slot counts"]')){const id=list.getAttribute('aria-label').replace(/ host slot counts$/,'');for(const li of list.querySelectorAll('li[data-host]'))hostSlots[id+':'+li.dataset.host]=li.querySelector('b')?.textContent.trim();}const context=document.createElement('canvas').getContext('2d');const endpointWordsOk=[...ep.querySelectorAll('tbody tr td:nth-child(3)')].every(cell=>{const cs=getComputedStyle(cell);context.font=cs.font;const available=cell.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);return cell.textContent.trim().split(/\\s+/).every(word=>context.measureText(word).width<=available+1);});const hookWordMetrics=[];const wordsOf=(cell,node,kind)=>{const cs=getComputedStyle(node),box=getComputedStyle(cell),available=cell.clientWidth-parseFloat(box.paddingLeft)-parseFloat(box.paddingRight);context.font=cs.font;for(const word of node.textContent.trim().split(/\\s+/)){const measured=context.measureText(word).width;hookWordMetrics.push({kind,word,measured,available,fits:measured<=available+1});}};if(hook){for(const cell of hook.querySelectorAll('thead th'))if(cell.getClientRects().length)wordsOf(cell,cell,'header');for(const link of hook.querySelectorAll('tbody td:first-child a'))wordsOf(link.closest('td'),link,'host');}const hookWordsOk=hookWordMetrics.every(word=>word.fits);const hookScroll=n?.querySelector('.cn-hook-scroll'),hookScrollOk=!hookScroll||hookScroll.scrollWidth<=hookScroll.clientWidth+1||hookScroll.tabIndex===0&&hookScroll.getAttribute('role')==='region';const counts={};for(const match of (hook?.innerText??'').matchAll(/(exit|timeout):\\s*(\\d+)/g))counts[match[1]]=Number(match[2]);return{canvas:s.getPropertyValue('--canvas').trim(),fonts:document.fonts.status,font:s.fontFamily,css:[...document.styleSheets].some(t=>t.href?.endsWith('/static/console.css')&&t.cssRules.length>100),cardRadius:parseFloat(getComputedStyle(document.querySelector('.card')).borderRadius),width:document.scrollingElement.scrollWidth,csp:window.__connectionsCsp??[],forges:f?.innerText??'',notify:n?.innerText??'',endpoints:ep?.innerText??'',problems:text('#p-connection-problems'),links:[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')),unauthorized:unauthorized?.cells[1].textContent.trim()??null,receiverPort:port,receiverTimes:f?.querySelectorAll('time[datetime]').length??0,hookCounts:counts,hookAttention:[...(n?.querySelectorAll('.cn-state.tone-attention')??[])].map(e=>e.textContent.trim()),hookTimes:n?.querySelectorAll('time[datetime]').length??0,hookWordsOk,hookWordMetrics,hookScrollOk,hostSlots,endpointWordsOk,localScope:[...ep.querySelectorAll('ul[aria-label="local-model host slot counts"] li')].every(li=>/no fleet bound/.test(li.innerText))};})()`;

export async function checkConnectionsBrowser({ chrome, slice, shots = null, sandbox = process.env.GITHUB_ACTIONS !== "true" } = {}) {
  assert.ok(CONNECTIONS_SLICES.includes(slice), "Choose the explicit implementation slice to verify");
  const work = mkdtempSync(join(tmpdir(), "pd-connections-browser-")), children = new Set();
  let fixture, browser, tab, stage = "startup", unauthorized = 2, scriptsDisabled = false;
  const paints = [];
  const additional = { agedPaints: 0, maxIdentityPaints: 0, unreadableIdentityPaints: 0, identityNegativeControl: false };
  try {
    mkdirSync(join(work, "chrome")); mkdirSync(join(work, "app"));
    fixture = await startConnectionsBrowserFixture(join(work, "app"), { slice });
    browser = await openChrome({ chrome, work: join(work, "chrome"), children, env: { HOME: process.env.HOME }, extraArgs: chromeLaunchArgs({ sandbox }), resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", captureStderr: true });
    assert.equal((await browser.send("Browser.getVersion")).product.split("/")[1], JSON.parse(readFileSync(new URL("../chrome-for-testing.json", import.meta.url))).version);
    tab = await browser.openTarget(); await tab.send("Page.enable"); await tab.send("Page.bringToFront"); await tab.send("Runtime.enable"); await tab.send("Network.enable"); await tab.send("DOM.enable"); await tab.send("CSS.enable");
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__connectionsCsp=[];window.__connectionsErrors=[];addEventListener('error',e=>window.__connectionsErrors.push(String(e.message)));addEventListener('unhandledrejection',()=>window.__connectionsErrors.push('unhandled rejection'));addEventListener('securitypolicyviolation',e=>window.__connectionsCsp.push(e.violatedDirective+':'+e.blockedURI));" });
    const evaluate = async expression => {
      const result = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async expression => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try { if (await evaluate(expression)) return; } catch (error) { if (!/context|navigat/.test(error.message)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error(`Timed out: ${expression}; scroll=${JSON.stringify(await evaluate("(()=>{const r=document.querySelector('.cn-receiver-hours-scroll');return r?{left:r.scrollLeft,x:r.getBoundingClientRect().left,head:r.querySelector('th').getBoundingClientRect().left,wrap:r.firstElementChild.getBoundingClientRect().left,active:document.activeElement.className}:null;})()"))}`);
    };
    const navigate = async path => {
      const loaded = browser.event(m => m.sessionId === tab.sessionId && m.method === "Page.loadEventFired", "Connections document load");
      const response = browser.event(m => m.sessionId === tab.sessionId && m.method === "Network.responseReceived" && m.params.type === "Document" && m.params.response.url.startsWith(fixture.origin + "/"), "Connections document headers");
      loaded.catch(() => {}); response.catch(() => {});
      await tab.send("Page.navigate", { url: fixture.origin + path }); await loaded;
      const headers = Object.fromEntries(Object.entries((await response).params.response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.equal(headers["content-security-policy"], SECURITY_HEADERS["content-security-policy"]);
      await until("document.readyState==='complete'"); await evaluate("document.fonts.ready.then(()=>true)");
      if (!scriptsDisabled) await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    };
    const press = async (key, code, windowsVirtualKeyCode) => {
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
    };
    const login = async role => {
      await tab.send("Network.clearBrowserCookies"); await navigate("/login");
      await until("document.querySelector('#token')&&!document.querySelector('#token').disabled");
      await evaluate("document.querySelector('#token').focus()"); await tab.send("Input.insertText", { text: CONNECTIONS_BROWSER_TOKENS[role] });
      await press("Tab", "Tab", 9); await press("Enter", "Enter", 13); await until("location.pathname==='/'");
    };
    const capture = async (name, selector = null) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true }); await evaluate("scrollTo(0,0)");
      const metrics = await tab.send("Page.getLayoutMetrics");
      const rect = selector ? await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};})()`) : { x: 0, y: 0, ...(metrics.cssContentSize ?? metrics.contentSize) };
      const result = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...rect, scale: 1 } }, 60000);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(result.data, "base64"));
    };
    const check = async (width, theme, absent = false) => {
      const evidence = await evaluate(EVIDENCE);
      assert.deepEqual(await evaluate("window.__connectionsErrors??[]"), [], `${stage}: browser script errors`);
      const { root } = await tab.send("DOM.getDocument", { depth: 1 });
      const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: "h1" });
      const { fonts } = await tab.send("CSS.getPlatformFontsForNode", { nodeId });
      assert.ok(fonts.length > 0 && fonts.every(font => font.glyphCount > 0 && !/Times|serif/i.test(font.familyName)), `${stage}: native heading font did not render`);
      evidence.platformFonts = fonts;
      const options = { slice, width, theme, receiverPort: fixture.receiverPort, unauthorized, absent };
      assert.deepEqual(connectionsEvidenceProblems(evidence, options), [], `${stage}: ${JSON.stringify(evidence)}`);
      assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true, `${stage}: labels and complete content fit`);
      return evidence;
    };
    for (const role of ["operator", "viewer"]) {
      await login(role);
      for (const theme of ["light", "dark"]) for (const width of [320, 375, 390, 760, 761, 800, 1024, 1440]) {
        stage = `${slice} ${role} ${theme} ${width}`;
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await navigate("/config/connections");
        const evidence = await check(width, theme); paints.push({ stage, ...evidence });
        if ([390, 800, 1440].includes(width)) {
          await capture(`${slice}-${role}-${theme}-${width}`);
          if (width === 390 || width === 1440) await capture(`${slice}-section-${role}-${theme}-${width}`, slice === "receiver" ? "#p-forges" : slice === "hooks" ? "#p-notify" : "#p-endpoints");
          if (slice === "baseline" && (width === 390 || width === 1440)) for (const [name, selector] of [["receiver", "#p-forges"], ["hooks", "#p-notify"], ["endpoints", "#p-endpoints"]]) await capture(`before-${name}-${role}-${theme}-${width}`, selector);
          if (slice === "receiver" || slice === "all") {
            const disclosure = '#p-forges .cn-receiver-detail>summary';
            await evaluate(`document.querySelector(${JSON.stringify(disclosure)}).focus()`); await press("Enter", "Enter", 13);
            await evaluate("document.querySelector('#p-forges .cn-receiver-detail details>summary').focus()"); await press("Enter", "Enter", 13);
            const hourly = await evaluate(`(()=>{const table=document.querySelector('table[aria-label="mini1 github delivery counts per UTC hour"]');const column=[...table.tHead.rows[0].cells].findIndex(cell=>cell.textContent==='unauthorized');return[...table.tBodies[0].rows].map(row=>row.cells[column].textContent.trim());})()`);
            assert.equal(hourly.length, 24);
            assert.equal(hourly.filter(value => /^\d+$/.test(value)).reduce((sum, value) => sum + Number(value), 0), unauthorized, "Hourly rendered counts add to the observed outcome count");
            assert.ok(hourly.slice(0, 23).every(value => !/^\d+$/.test(value)), "Hours before receiver startup remain unobserved");
            const hourLayout = await evaluate(`(()=>{const region=document.querySelector('.cn-receiver-hours-scroll'),table=region.querySelector('table'),context=document.createElement('canvas').getContext('2d');return{scroll:region.scrollWidth,client:region.clientWidth,words:[...table.tHead.rows[0].cells].map(cell=>{const cs=getComputedStyle(cell);context.font=cs.font;return {text:cell.textContent.trim(),fits:context.measureText(cell.textContent.trim()).width<=cell.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)+1};})};})()`);
            assert.ok(hourLayout.words.every(word => word.fits), "Every hourly column label retains its actual rendered word width");
            if (hourLayout.scroll > hourLayout.client) {
              await evaluate("document.querySelector('.cn-receiver-hours-scroll').focus()");
              await press("ArrowRight", "ArrowRight", 39);
              await until("document.querySelector('.cn-receiver-hours-scroll').scrollLeft>0");
              await new Promise(resolve => setTimeout(resolve, 250));
              await evaluate("document.querySelector('.cn-receiver-hours-scroll').scrollTo({left:0,behavior:'instant'})");
              await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
              await until("(()=>{const r=document.querySelector('.cn-receiver-hours-scroll');return r.scrollLeft===0&&r.querySelector('th').getBoundingClientRect().left>=r.getBoundingClientRect().left-0.5;})()");
            }
            await check(width, theme);
            await capture(`${slice}-hours-${role}-${theme}-${width}`, "#p-forges");
          }
        }
        if (role === "viewer") assert.equal(await evaluate("document.querySelectorAll('form[data-action]').length"), 0);
      }
    }
    stage = "read-only operator";
    await fixture.close();
    fixture = await startConnectionsBrowserFixture(join(work, "app"), { slice, readOnly: true });
    await login("operator");
    for (const theme of ["light", "dark"]) for (const width of [390, 800, 1440]) {
      stage = `${slice} read-only operator ${theme} ${width}`;
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await navigate("/config/connections"); paints.push({ stage, ...await check(width, theme) });
      assert.equal(await evaluate("document.querySelectorAll('form[data-action]').length"), 0);
      await capture(`${slice}-readonly-operator-${theme}-${width}`);
    }
    stage = "native disclosure keyboard";
    await navigate("/config/connections");
    const summary = slice === "receiver" ? '#p-forges details>summary' : '#p-env details>summary';
    await evaluate(`document.querySelector(${JSON.stringify(summary)}).focus()`);
    await press("Enter", "Enter", 13);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(summary)}).parentElement.open`), true);
    await press("Enter", "Enter", 13);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(summary)}).parentElement.open`), false);
    if (slice === "hooks" || slice === "all") {
      stage = "whole hook identity in a keyboard-scrollable table";
      const savedHost = await evaluate("document.querySelector('#p-notify tbody td:first-child a').textContent");
      await evaluate("document.querySelector('#p-notify tbody td:first-child a').textContent='h'.repeat(64)");
      const hookLayout = await evaluate("({ words: (" + EVIDENCE + ").hookWordsOk, metrics: (" + EVIDENCE + ").hookWordMetrics, focusable: (" + EVIDENCE + ").hookScrollOk, overflow: document.querySelector('.cn-hook-scroll').scrollWidth>document.querySelector('.cn-hook-scroll').clientWidth })");
      assert.equal(hookLayout.words, true, `A maximum-length identity stays whole within its cell: ${JSON.stringify(hookLayout.metrics)}`);
      assert.equal(hookLayout.focusable, true);
      assert.equal(hookLayout.overflow, true, "The long identity exercises real overflow rather than a synthetic flag");
      await evaluate("document.querySelector('.cn-hook-scroll').focus()"); await press("ArrowRight", "ArrowRight", 39);
      await until("document.querySelector('.cn-hook-scroll').scrollLeft>0");
      await evaluate(`document.querySelector('#p-notify tbody td:first-child a').textContent=${JSON.stringify(savedHost)};document.querySelector('.cn-hook-scroll').scrollLeft=0`);
      await until("document.querySelector('.cn-hook-scroll').scrollLeft===0");
    }
    stage = "keyboard host navigation";
    const hostLink = slice === "receiver" ? '#p-forges a[href="/fleet/host?name=mini1"]' : slice === "hooks" ? '#p-notify a[href="/fleet/host?name=build3"]' : '#p-endpoints a[href="/fleet/host?name=mini1"]';
    if (slice !== "baseline") {
      await evaluate(`document.querySelector(${JSON.stringify(hostLink)}).focus()`); await press("Enter", "Enter", 13);
      await until("location.pathname==='/fleet/host'"); await navigate("/config/connections");
    }
    if (slice === "hooks" || slice === "all") {
      stage = "keyboard run navigation";
      await evaluate("document.querySelector('#p-notify a[href=\"/run?id=gh-timeout-775\"]').focus()"); await press("Enter", "Enter", 13);
      await until("location.pathname==='/run'&&location.search==='?id=gh-timeout-775'"); await navigate("/config/connections");
    }
    stage = "theme keyboard interaction";
    await evaluate("document.querySelector('[data-theme-toggle]').focus()"); await press("Enter", "Enter", 13);
    await until("document.documentElement.dataset.theme==='light'"); await navigate("/config/connections");
    await check(1440, "light");
    if (slice === "receiver" || slice === "all") {
      stage = "actual delivery and reload";
      await fixture.addRefusal(); unauthorized = 3;
      await navigate("/config/connections"); await check(1440, "light");
    }
    stage = "no JavaScript facts and disclosure";
    scriptsDisabled = true;
    await tab.send("Emulation.setScriptExecutionDisabled", { value: true });
    await navigate("/config/connections"); await check(1440, "light");
    assert.equal(await evaluate("document.querySelector('[data-theme-toggle]').hidden"), true);
    await evaluate(`document.querySelector(${JSON.stringify(summary)}).focus()`); await press("Enter", "Enter", 13);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(summary)}).parentElement.open`), true);
    await capture(`${slice}-readonly-operator-no-script-light-1440`);
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
    scriptsDisabled = false;
    stage = "CSP negative control"; await navigate("/config/connections");
    await evaluate("window.__inlineRan=false;const script=document.createElement('script');script.textContent='window.__inlineRan=true';document.head.appendChild(script)");
    await until("window.__connectionsCsp.some(value=>value.startsWith('script-src')&&value.endsWith(':inline'))");
    assert.equal(await evaluate("window.__inlineRan"), false);
    stage = "shared styling negative control"; await navigate("/config/connections");
    await evaluate("document.querySelector('link[href=\"/static/console.css\"]').disabled=true");
    assert.ok(connectionsEvidenceProblems(await evaluate(EVIDENCE), { slice, width: 1440, theme: "light", receiverPort: fixture.receiverPort, unauthorized }).length > 0);
    if (!["all", "baseline"].includes(slice)) {
      stage = "deleted publications are unknown"; await fixture.removeTelemetry();
      await navigate("/config/connections"); await check(1440, "light", true);
      await capture(`${slice}-not-reported-light-1440`);
    }
    if (slice === "receiver" || slice === "all") {
      stage = "unserved lifetime refusal after the count window expires";
      await fixture.close(); fixture = null;
      fixture = await startConnectionsBrowserFixture(join(work, "aged-app"), { slice: "receiver", readOnly: true, agedReceiver: true });
      const published = JSON.parse(await fixture.redis.get("receiver:h:mini1"));
      assert.equal(published.deliveries.gitlab["not-configured"].lastAt, fixture.agedRefusedAt);
      assert.equal(published.deliveries.gitlab["not-configured"].hours.reduce((sum, [, n]) => sum + n, 0), 0);
      const agedPaints = [];
      for (const [role, theme, width] of [["viewer", "light", 390], ["operator", "dark", 1440]]) {
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await login(role); await navigate("/config/connections");
        const table = 'table[aria-label="mini1 gitlab delivery outcomes"]';
        await evaluate(`document.querySelector(${JSON.stringify(table)}).closest('details').querySelector('summary').focus()`);
        await press("Enter", "Enter", 13);
        const observed = await evaluate(`(()=>{const table=document.querySelector(${JSON.stringify(table)}),details=table.closest('details'),facts=details.previousElementSibling;return{open:details.open,heading:facts.previousElementSibling.textContent,counts:[...table.tBodies[0].rows].map(row=>[row.cells[0].textContent.trim(),row.cells[1].textContent.trim()]),lastRefused:[...facts.querySelectorAll('.fact')].find(row=>row.querySelector('dt').textContent==='Last refused').querySelector('time').getAttribute('datetime'),emptyUnserved:[...document.querySelectorAll('table')].some(table=>/^mini1 (forgejo|azure) delivery outcomes$/.test(table.getAttribute('aria-label')??''))};})()`);
        assert.equal(observed.open, true);
        assert.match(observed.heading, /gitlab.*\(not served\)/);
        assert.equal(observed.counts.length, 11);
        assert.ok(observed.counts.every(([, count]) => count === "0"));
        assert.equal(observed.lastRefused, new Date(fixture.agedRefusedAt).toISOString());
        assert.equal(observed.emptyUnserved, false);
        const evidence = await evaluate(EVIDENCE);
        assert.equal(evidence.fonts, "loaded"); assert.equal(evidence.css, true);
        assert.equal(evidence.canvas, theme === "light" ? "#edeeec" : "#000000");
        assert.deepEqual(evidence.csp, []); assert.deepEqual(await evaluate("window.__connectionsErrors??[]"), []);
        assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true);
        agedPaints.push({ role, theme, width, ...observed, fonts: evidence.fonts, css: evidence.css, canvas: evidence.canvas, csp: evidence.csp });
        await capture(`receiver-aged-refusal-${role}-${theme}-${width}`, "#p-forges");
      }
      if (shots) writeFileSync(join(shots, "receiver-aged-refusal-measurements.json"), JSON.stringify(agedPaints, null, 2));
      additional.agedPaints = agedPaints.length;
    }
    if (slice === "receiver" || slice === "all") {
      stage = "complete maximum-length receiver identity";
      await fixture.close(); fixture = null;
      const name = "W".repeat(64);
      fixture = await startConnectionsBrowserFixture(join(work, "max-app"), { slice: "receiver", receiverName: name });
      const published = JSON.parse(await fixture.redis.get(`receiver:h:${name}`));
      assert.equal(published.name, name, "the maximum identity comes from the production publisher");
      const inspectIdentity = async (role, theme, width) => {
        await evaluate("(()=>{const r=document.querySelector('.cn-receivers').getBoundingClientRect();scrollTo({left:0,top:r.top+scrollY,behavior:'instant'});})()");
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        const observed = await evaluate(RECEIVER_IDENTITY);
        assert.deepEqual(receiverIdentityProblems(observed, { name, width }), [], `${stage}: ${JSON.stringify(observed)}`);
        assert.equal(observed.fonts, "loaded"); assert.equal(observed.css, true); assert.ok(observed.fontSize >= 12);
        assert.equal(observed.canvas, theme === "light" ? "#edeeec" : "#000000");
        assert.deepEqual(observed.csp, []); assert.deepEqual(observed.errors, []);
        const { root } = await tab.send("DOM.getDocument", { depth: 1 });
        const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".cn-receivers a[href]" });
        const { fonts } = await tab.send("CSS.getPlatformFontsForNode", { nodeId });
        assert.ok(fonts.length > 0 && fonts.every(font => font.glyphCount > 0 && !/Times|serif/i.test(font.familyName)));
        assert.ok(fonts.reduce((sum, font) => sum + font.glyphCount, 0) >= name.length, "all identity glyphs use the loaded native font");
        assert.equal(widthVerdict(await evaluate(measureSource(width, EDGE_SLACK)), width).ok, true);
        return { role, theme, width, ...observed, platformFonts: fonts };
      };
      const maxPaints = [];
      for (const role of ["operator", "viewer"]) {
        await login(role);
        for (const theme of ["light", "dark"]) for (const width of [320, 375, 390, 760, 761, 800, 1024, 1440]) {
          stage = `maximum receiver ${role} ${theme} ${width}`;
          await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
          await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
          await navigate("/config/connections");
          maxPaints.push(await inspectIdentity(role, theme, width));
          if ([320, 390, 800, 1440].includes(width)) await capture(`receiver-max-name-${role}-${theme}-${width}`, "#p-forges");
        }
      }
      stage = "receiver identity wrapping negative control";
      await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await login("operator"); await navigate("/config/connections");
      const beforeNegative = await inspectIdentity("operator", "light", 390);
      const rule = await evaluate("(()=>{const sheet=document.querySelector('link[href=\"/static/console.css\"]').sheet,index=[...sheet.cssRules].findIndex(rule=>rule.selectorText==='.cn-receivers a');if(index<0)throw Error('receiver identity rule absent');const text=sheet.cssRules[index].cssText;sheet.deleteRule(index);return{index,text};})()");
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const clipped = await evaluate(RECEIVER_IDENTITY);
      assert.ok(receiverIdentityProblems(clipped, { name, width: 390 }).some(problem => problem.includes("characters are clipped")), "removing only the scoped rule must reproduce missing glyphs");
      await capture("receiver-max-name-negative-control-light-390", "#p-forges");
      await evaluate(`document.querySelector('link[href="/static/console.css"]').sheet.insertRule(${JSON.stringify(rule.text)},${rule.index})`);
      const restored = await inspectIdentity("operator", "light", 390);
      if (shots) writeFileSync(join(shots, "receiver-max-name-negative-control.json"), JSON.stringify({ before: beforeNegative, clipped, restored }, null, 2));
      const unsupported = { ...published, v: 2 };
      await fixture.removeTelemetry();
      await fixture.redis.set(`receiver:h:${name}`, JSON.stringify(unsupported), "PX", 90_000);
      await fixture.redis.sadd("receiver:live", name);
      const unreadablePaints = [];
      for (const [role, theme, width] of [["viewer", "light", 320], ["operator", "dark", 390]]) {
        stage = `unreadable maximum receiver ${role} ${theme} ${width}`;
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: true });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await login(role); await navigate("/config/connections");
        assert.match(await evaluate("document.querySelector('.cn-receivers').innerText"), /receiver observation unreadable/);
        unreadablePaints.push(await inspectIdentity(role, theme, width));
        await capture(`receiver-max-name-unreadable-${role}-${theme}-${width}`, "#p-forges");
      }
      if (shots) {
        writeFileSync(join(shots, "receiver-max-name-measurements.json"), JSON.stringify(maxPaints, null, 2));
        writeFileSync(join(shots, "receiver-max-name-unreadable-measurements.json"), JSON.stringify(unreadablePaints, null, 2));
      }
      additional.maxIdentityPaints = maxPaints.length;
      additional.unreadableIdentityPaints = unreadablePaints.length;
      additional.identityNegativeControl = true;
    }
    writeFileSync(shots ? join(shots, `${slice}-measurements.json`) : join(work, "measurements.json"), JSON.stringify(paints, null, 2));
    return { ok: true, slice, paints: paints.length, ...additional, interactions: ["keyboard-disclosure", ...(slice === "baseline" ? [] : ["keyboard-host-navigation"]), ...(["hooks", "all"].includes(slice) ? ["keyboard-run-navigation"] : []), ...(["receiver", "all"].includes(slice) ? ["hourly-disclosure-and-sums", "actual-delivery-and-reload", "complete-receiver-identities", "receiver-identity-negative-control"] : []), "theme", "no-script", "CSP-negative-control", "styling-negative-control", ...(["all", "baseline"].includes(slice) ? [] : ["deletion"])] };
  } catch (error) { throw new Error(`Connections browser ${stage}: ${error.message}`, { cause: error }); }
  finally {
    if (tab) await tab.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    for (const child of children) try { child.kill("SIGKILL"); } catch {}
    if (fixture) await fixture.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = process.argv.includes("--require");
  const slice = process.argv[process.argv.indexOf("--slice") + 1];
  const shotsAt = process.argv.indexOf("--shots"), shots = shotsAt < 0 ? null : process.argv[shotsAt + 1];
  const chrome = findChrome();
  if (!chrome?.path) { console.log("Connections browser: Chrome absent"); if (required) process.exitCode = 1; }
  else try { console.log(JSON.stringify(await checkConnectionsBrowser({ chrome: chrome.path, slice, shots }))); } catch (error) { console.error(error); process.exitCode = 1; }
}
