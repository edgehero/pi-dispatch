/** Real browser, production policies and an existing live sandbox TTY. No provider or forge call (#753, #754). */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { openChrome } from "../../launch/chrome-pipe.mjs";
import { chromeLaunchArgs, findChrome } from "./console-width-check.mjs";
import { buildSandboxRunArgs, sandboxContainerName } from "../../worker/src/sandbox.mjs";
import { makeRedisClient } from "../../worker/src/connection.mjs";
import { renewSandboxSession, releaseSandboxSession, readSandboxSessions } from "../../worker/src/sandbox-sessions.mjs";
import { makeGatewayStore } from "../../worker/src/sandbox-gateway-protocol.mjs";
import { createConsoleServer } from "../../admin/src/console/server.mjs";
import * as cookies from "../../admin/src/console/sessions.mjs";
import { findToken } from "../../worker/src/console-tokens.mjs";
import { makeGatewayBroker } from "../../admin/src/console/gateway-broker.mjs";
import { makeConfirmTickets } from "../../admin/src/console/confirm.mjs";
import { makeConsoleAudit } from "../../worker/src/console-audit.mjs";
import { makeLoginLimiter } from "../../admin/src/console/guards.mjs";
import { SECURITY_HEADERS } from "../../admin/src/console/headers.mjs";
import { createGatewayServer, gatewayHeaders } from "../../gateway/src/server.mjs";
import { makeGatewayRuntime } from "../../gateway/src/runtime.mjs";
import { makeGatewayAudit } from "../../gateway/src/audit.mjs";
import { gatewayTestCertificate, gatewayTlsFront, TLS_CONSOLE_HOST, TLS_GATEWAY_HOST, TLS_UNTRUSTED_HOST } from "./sandbox-gateway-tls-fixture.mjs";
import { createServer as createHttpServer } from "node:http";
import { buildGatewayAssets } from "../../gateway/build.mjs";
import { sandboxFixture } from "../../admin/test/helpers/sandbox-goldens.mjs";
import { parseSandboxOpenUrl } from "../../worker/src/opener-protocol.mjs";

const exec = promisify(execCallback), sha = (v) => createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argv = process.argv.slice(2), shotArg = argv.indexOf("--shots"), shots = shotArg < 0 ? null : argv[shotArg + 1];
const tls = argv.includes("--tls");
const TLS_SIBLING_HOST = "sibling.other-browser.test";
const venue = process.env.PI_SANDBOX_GATEWAY_VENUE ?? "local", bin = venue === "podman" ? "podman" : "docker";
assert.ok(["local", "podman"].includes(venue));
assert.ok(process.env.PI_JOB_IMAGE, "PI_JOB_IMAGE must name an already-built pinned job image");
assert.ok(process.env.VALKEY_TEST_URL, "VALKEY_TEST_URL must name an isolated live test control store");
assert.ok(process.env.PI_SANDBOX_GATEWAY_SOCKET, "PI_SANDBOX_GATEWAY_SOCKET must name the actual local runtime socket");
const chrome = findChrome(); assert.ok(chrome.path, "a real Chrome is required");
const work = fs.mkdtempSync(join(tmpdir(), "pd-gateway-browser-")), children = new Set();
const runId = `gh-${randomBytes(16).toString("hex")}`, host = `browser-${randomBytes(8).toString("hex")}`, nonce = randomBytes(16).toString("hex");
const name = sandboxContainerName(runId), token = `pdc_${randomBytes(32).toString("base64url")}`;
const prefix = `gateway-browser-${randomBytes(8).toString("hex")}:`;
let redis, consoleServer, gateway, browser, broker, registration, renewer, stage = "startup";
const audits = [], requests = [], tlsFronts = [];
const extraShells = [], allBrowsers = [];
const siblingNonce = randomBytes(32).toString("base64url");
const operatorTokens = new Map(["ops", "lee", "sam", "kim", "pat"].map(person => [person, person === "ops" ? token : `pdc_${randomBytes(32).toString("base64url")}`]));
async function port() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
try {
  const workspace = join(work, "workspace"), jobDir = join(work, "job");
  fs.mkdirSync(workspace, { mode: 0o777 }); fs.chmodSync(workspace, 0o777); fs.mkdirSync(jobDir, { mode: 0o755 });
  const user = venue === "podman" ? `${process.getuid()}:${process.getgid()}` : null;
  const args = buildSandboxRunArgs({ venue, image: process.env.PI_JOB_IMAGE, name, workspace, jobDir, user, home: user ? "/home/pi" : null, term: "xterm-256color", idleSeconds: 0, cgroupParent: null });
  args.splice(1, 0, "-d"); args.splice(args.length - 1, 0, "--label", `org.pi-dispatch.sandbox-session=${nonce}`);
  await exec(bin, args, { timeout: 30000 });
  const inspected = JSON.parse((await exec(bin, ["inspect", name])).stdout)[0];
  registration = { v: 1, host, id: runId, nonce, containerId: inspected.Id, venue, by: "browser-smoke", since: Date.now(), at: Date.now() };
  redis = makeRedisClient(process.env.VALKEY_TEST_URL, { noOfflineQueue: true, lazyConnect: true, disconnectTimeoutMs: 0 }); redis.on("error", () => {}); await redis.connect();
  await renewSandboxSession(redis, registration);
  renewer = setInterval(() => { for (const shell of [registration, ...extraShells]) void renewSandboxSession(redis, shell).catch(() => {}); }, 1000);
  const consolePort = await port(), gatewayPort = await port();
  // Different sites, not merely different ports: Strict cookies are genuinely withheld on both return GETs.
  const consoleOrigin = tls ? `https://${TLS_CONSOLE_HOST}:${consolePort}` : `http://localhost:${consolePort}`;
  const gatewayOrigin = tls ? `https://${TLS_GATEWAY_HOST}:${gatewayPort}` : `http://127.0.0.1:${gatewayPort}`;
  const certificate = tls ? await gatewayTestCertificate(join(work, "tls"), [TLS_CONSOLE_HOST, TLS_GATEWAY_HOST, TLS_SIBLING_HOST]) : null;
  const config = { dir: work, allowedHosts: tls ? [TLS_CONSOLE_HOST] : [], readOnly: false, maxMs: 3600000, logsDir: join(work, "console-logs") };
  const file = { version: 1, generation: 0, tokens: [...operatorTokens].map(([person, secret]) => ({ name: person, role: "operator", sha256: sha(secret) })).concat(["viewer", "agent"].map(role => ({ name: role, role, sha256: sha(role) }))) };
  const sessions = cookies.makeSessionStore();
  const store = makeGatewayStore({ redis, prefix });
  const audit = makeConsoleAudit({ logsDir: config.logsDir });
  const journal = makeGatewayAudit({ logsDir: join(work, "gateway-logs") }); journal.recover();
  const registry = { config: { version: 1, consoleOrigin, hosts: { [host]: { origin: gatewayOrigin } } }, digest: "browser-fixture" };
  const recordFor = id => ({ jobId: id, host, backend: venue, kind: "github", target: "acme/web#490", project: "web", flow: "fix", outcome: "completed", startedAt: new Date(registration.since - 3600000).toISOString(), endedAt: new Date(registration.since - 1800000).toISOString() });
  broker = makeGatewayBroker({ redis, store, sessions, readTokens: () => ({ file }), findToken, readRegistry: () => registry, audit, readOnly: () => config.readOnly, readSessions: () => readSandboxSessions(redis, { hosts: [host] }), readRun: async id => ({ source: "local", record: recordFor(id) }) });
  const limiter = makeLoginLimiter({ now: () => Date.now() });
  // Real page rendering reads the same live registration as the broker. Only retained inventory is a fixture;
  // the clicked CTA still goes through production step-up, store, audit, lease and runtime admission below.
  const inventory = sandboxFixture(Date.now());
  inventory.hosts = [{ ...inventory.hosts[0], name: host, rows: [{ ...inventory.hosts[0].rows[0], id: runId, v: venue }] }];
  inventory.selected.host = host;
  const liveShells = () => readSandboxSessions(redis, { hosts: [host] });
  async function extraShell(index) {
    const id = `gh-${randomBytes(16).toString("hex")}`, shellNonce = randomBytes(16).toString("hex");
    const workspacePath = join(work, `workspace-${index}`), jobPath = join(work, `job-${index}`);
    fs.mkdirSync(workspacePath, { mode: 0o777 }); fs.chmodSync(workspacePath, 0o777); fs.mkdirSync(jobPath, { mode: 0o755 });
    const shellArgs = buildSandboxRunArgs({ venue, image: process.env.PI_JOB_IMAGE, name: sandboxContainerName(id), workspace: workspacePath, jobDir: jobPath, user, home: user ? "/home/pi" : null, term: "xterm-256color", idleSeconds: 0, cgroupParent: null });
    shellArgs.splice(1, 0, "-d"); shellArgs.splice(shellArgs.length - 1, 0, "--label", `org.pi-dispatch.sandbox-session=${shellNonce}`);
    await exec(bin, shellArgs, { timeout: 30000 });
    const state = JSON.parse((await exec(bin, ["inspect", sandboxContainerName(id)])).stdout)[0];
    const shell = { v: 1, host, id, nonce: shellNonce, containerId: state.Id, venue, by: "native-opener", since: Date.now(), at: Date.now() };
    extraShells.push(shell); await renewSandboxSession(redis, shell);
    inventory.hosts[0].rows.push({ ...inventory.hosts[0].rows[0], id, v: venue });
    return shell;
  }
  const pageDeps = {
    fleet: { parkedCount: async () => 0, runById: async id => ({ source: "local", record: recordFor(id) }) },
    sandboxes: { hosts: () => ({ config: { version: 1, hosts: { [host]: { target: `ops@${host}`, deployment: "/srv/pi", nodePath: "/usr/bin/node", cliPath: "/srv/pi/node_modules/@edgehero/pi-dispatch/src/cli.mjs" } } } }), read: async () => ({ ...inventory, sessions: (await liveShells()).sessions }) },
    gatewayView: () => broker.view(),
  };
  consoleServer = createConsoleServer({ limiter, config, sessions, cookies, tickets: makeConfirmTickets(), readTokens: () => ({ file }), findToken, audit, gateway: broker, consoleOrigin: () => consoleOrigin, pageDeps });
  if (tls) tlsFronts.push(await gatewayTlsFront(consoleServer, consolePort, certificate));
  else await new Promise((r) => consoleServer.listen(consolePort, "0.0.0.0", r));
  const gatewayConfig = { origin: gatewayOrigin, consoleOrigin, host, sockets: { [venue]: process.env.PI_SANDBOX_GATEWAY_SOCKET }, idleMinutes: 30 };
  gateway = createGatewayServer({ config: gatewayConfig, store, runtime: makeGatewayRuntime({ sockets: gatewayConfig.sockets }), assets: await buildGatewayAssets(), audit: async (...values) => { audits.push(values[0]); return journal.record(...values); } });
  if (tls) tlsFronts.push(await gatewayTlsFront(gateway.server, gatewayPort, certificate));
  else await new Promise((r) => gateway.server.listen(gatewayPort, "127.0.0.1", r));
  gateway.server.prependListener("request", (req) => { requests.push({ method: req.method, url: req.url, cookieNames: String(req.headers.cookie ?? "").split(";").map((p) => p.trim().split("=")[0]) }); });
  browser = await openChrome({ chrome: chrome.path, work, children, env: { HOME: process.env.HOME }, extraArgs: [...chromeLaunchArgs({ sandbox: process.env.GITHUB_ACTIONS !== "true" }), "--window-size=1600,1600", ...(tls ? [`--ignore-certificate-errors-spki-list=${certificate.spki}`] : [])], resolverRules: tls ? `MAP ${TLS_CONSOLE_HOST} 127.0.0.1, MAP ${TLS_GATEWAY_HOST} 127.0.0.1, MAP ${TLS_UNTRUSTED_HOST} 127.0.0.1, MAP ${TLS_SIBLING_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` : "MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", captureStderr: true });
  allBrowsers.push(browser);
  let tab = await browser.openTarget(); tab.browser = browser;
  const initializeTab = async () => { await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__gatewaySavedState=null;const originalGet=Storage.prototype.getItem,originalRemove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){const raw=originalGet.call(this,key);if(this===sessionStorage&&String(key).startsWith('sandbox-gateway:')){let saved;try{saved=JSON.parse(raw||'null')}catch{}let gatewayValid=false;try{gatewayValid=typeof saved?.gateway==='string'&&new URL(saved.gateway).origin===saved.gateway&&/^https?:/.test(saved.gateway)}catch{}window.__gatewaySavedState={present:raw!==null,parsed:!!saved,keys:saved&&typeof saved==='object'?Object.keys(saved).sort().join():null,proofValid:/^[A-Za-z0-9_-]{43}$/.test(saved?.proof||''),atValid:Number.isSafeInteger(saved?.at),ageMs:Number.isSafeInteger(saved?.at)?Date.now()-saved.at:null,gatewayValid};}return originalRemove.call(this,key);};window.__gatewayResizes=[];addEventListener('resize',()=>window.__gatewayResizes.push({width:innerWidth,height:innerHeight,at:performance.now()}));window.__gatewayCsp=[];addEventListener('securitypolicyviolation',e=>window.__gatewayCsp.push(e.violatedDirective+':'+e.blockedURI));window.__gatewayReplies=[];const nativeFetch=fetch;window.fetch=async(...args)=>{const response=await nativeFetch(...args);const path=new URL(String(args[0]),location.href).pathname;if(path.startsWith('/api/sandbox-gateway/')||path==='/api/connect'){try{const value=await response.clone().json();window.__gatewayReplies.push({path,status:response.status,refused:typeof value.refused==='string'?value.refused:null});}catch{}}return response;};window.__gatewaySockets=[];const NativeWebSocket=WebSocket;window.WebSocket=new Proxy(NativeWebSocket,{construct(ctor,args){const socket=new ctor(...args);window.__gatewaySockets.push(socket);return socket;}});" }); };
  await initializeTab();
  await browser.send("Target.setDiscoverTargets", { discover: true });
  const evaluate = async (expression) => {
    for (let n = 0; ; n++) {
      try { const result = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
      catch (e) { if (n >= 15 || !/context|navigat/.test(e.message)) throw e; await sleep(40); }
    }
  };
  const until = async (expression, ms = 12000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(30); }
    // Capture can itself resize a headless surface. Preserve the failure facts before collecting pixels.
    const diagnostic = await evaluate("JSON.stringify({url:location.origin+location.pathname,status:document.getElementById('gateway-status')?.textContent,state:(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-text]')||document.getElementById('gateway-state-text'))?.textContent,width:innerWidth,resizes:window.__gatewayResizes,ready:document.readyState,mode:document.querySelector('[data-sandbox-gateway-mode]')?.getAttribute('data-sandbox-gateway-mode'),savedState:window.__gatewaySavedState,terminal:[...document.querySelectorAll('.xterm-rows>div')].map(e=>e.textContent).join(' / ').slice(-1000)})");
    if (shots) { fs.mkdirSync(shots, { recursive: true }); const debug = await tab.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }); fs.writeFileSync(join(shots, "debug-failure.png"), Buffer.from(debug.data, "base64")); }
    throw new Error(`${stage}: timed out waiting for ${expression}; ` + diagnostic);
  };
  const navigate = async (url) => {
    // The URL commits before the new document parses, and a same-URL reload can otherwise
    // satisfy readyState with its predecessor. This marker belongs only to that predecessor.
    const marker = randomBytes(16).toString("hex");
    await evaluate(`document.__gatewayNavigationMarker=${JSON.stringify(marker)}`);
    await tab.send("Page.navigate", { url });
    await until(`document.__gatewayNavigationMarker!==${JSON.stringify(marker)}&&document.readyState==='complete'&&location.href===${JSON.stringify(url)}`);
  };
  const click = async (selector) => {
    await tab.send("Page.bringToFront");
    const box = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
  };
  const type = async (selector, text) => {
    await tab.send("Page.bringToFront");
    if (selector.includes("xterm")) await until(`document.querySelector(${JSON.stringify(selector)})?.readOnly===false&&document.querySelector(${JSON.stringify(selector)}).getClientRects().length>0`);
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control on '+location.pathname+' state '+(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title'))?.textContent+' '+(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-text]')||document.getElementById('gateway-state-text'))?.textContent);e.focus();${selector.includes("xterm") ? "" : "e.select?.();"}})()`);
    if (!selector.includes("xterm")) { await tab.send("Input.insertText", { text }); return; }
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await until(`document.activeElement===document.querySelector(${JSON.stringify(selector)})&&document.activeElement.readOnly===false`);
    // xterm's pinned screen-reader mode intentionally ignores input-only IME events. Drive actual key events.
    for (const character of text) {
      assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})&&document.activeElement.readOnly===false`), true, "terminal focus and input permission survive each real key event");
      const enter = character === "\n", key = enter ? "Enter" : character;
      const virtualKey = enter ? 13 : /^[A-Za-z0-9]$/.test(character) ? character.toUpperCase().charCodeAt(0) : 0;
      await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, windowsVirtualKeyCode: virtualKey, modifiers: /^[A-Z]$/.test(character) ? 8 : 0 });
      await tab.send("Input.dispatchKeyEvent", { type: "char", key, text: enter ? "\r" : character, unmodifiedText: enter ? "\r" : character, windowsVirtualKeyCode: virtualKey });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: virtualKey });
      await sleep(20); // Human-rate typing stays below the deliberately enforced frame-rate limit.
    }
  };
  const capture = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true }); await evaluate("document.fonts.ready.then(()=>window.scrollTo(0,0))"); await sleep(100);
    const namedTheme = /(?:^|-)(light|dark)(?:-|$)/.exec(name)?.[1];
    if (namedTheme) assert.equal(await evaluate("getComputedStyle(document.body).getPropertyValue('--canvas').trim()"), namedTheme === "light" ? "#edeeec" : "#000000", `${name} must actually draw its named theme`);
    const size = await evaluate("({width:innerWidth,height:innerHeight,content:document.documentElement.scrollHeight})");
    assert.ok(size.content <= size.height + 1, `Complete ${name} content fits the capture viewport: ${JSON.stringify(size)}`);
    const result = await tab.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(join(shots, name + ".png"), Buffer.from(result.data, "base64"));
    fs.writeFileSync(join(shots, name + ".probe.json"), JSON.stringify(await evaluate("({width:innerWidth,height:innerHeight,canvas:getComputedStyle(document.body).getPropertyValue('--canvas').trim(),fontStatus:document.fonts.status,font:getComputedStyle(document.body).fontFamily,sheets:[...document.styleSheets].map(s=>({href:s.href,rules:s.cssRules.length})),boxes:Object.fromEntries(['.wb-terminal','.xterm','.xterm-screen','.xterm-scrollable-element','.wb-pane'].map(q=>{const e=document.querySelector(q),r=e?.getBoundingClientRect(),c=e&&getComputedStyle(e);return[q,r?{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,box:c.boxSizing,padding:c.padding,scroll:e.scrollHeight}:null]})),formHidden:document.getElementById('gateway-step-up')?.hidden,resizes:window.__gatewayResizes})"), null, 2));
  };
  const captureDocument = async name => {
    if (!shots) return;
    await evaluate("document.fonts.ready.then(()=>window.scrollTo(0,0))"); await sleep(100);
    const size = await evaluate("({width:innerWidth,height:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,fonts:document.fonts.status,sheets:[...document.styleSheets].map(s=>({href:s.href,rules:s.cssRules.length}))})");
    assert.equal(size.overflow, false); assert.equal(size.fonts, "loaded"); assert.ok(size.height < 20000);
    const result = await tab.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
    fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(join(shots, name + ".png"), Buffer.from(result.data, "base64"));
    fs.writeFileSync(join(shots, name + ".probe.json"), JSON.stringify(size, null, 2));
  };
  const attachTab = async targetId => {
    const selectedBrowser = browser;
    const { sessionId } = await selectedBrowser.send("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, sessionId, browser: selectedBrowser, send: (method, params, ms) => selectedBrowser.send(method, params, sessionId, ms), close: () => selectedBrowser.send("Target.closeTarget", { targetId }) };
  };
  const isolatedTab = async () => {
    // A separate process/profile keeps the driver's rendered roster visible while another operator signs in.
    const profileWork = join(work, `operator-browser-${allBrowsers.length}`); fs.mkdirSync(profileWork);
    browser = await openChrome({ chrome: chrome.path, work: profileWork, children, env: { HOME: process.env.HOME }, extraArgs: [...chromeLaunchArgs({ sandbox: process.env.GITHUB_ACTIONS !== "true" }), "--window-size=1600,1600", ...(tls ? [`--ignore-certificate-errors-spki-list=${certificate.spki}`] : [])], resolverRules: tls ? `MAP ${TLS_CONSOLE_HOST} 127.0.0.1, MAP ${TLS_GATEWAY_HOST} 127.0.0.1, MAP ${TLS_UNTRUSTED_HOST} 127.0.0.1, MAP ${TLS_SIBLING_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` : "MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", captureStderr: true });
    allBrowsers.push(browser); tab = await browser.openTarget(); tab.browser = browser; await initializeTab();
    await browser.send("Target.setDiscoverTargets", { discover: true });
    return tab;
  };
  let currentOperator = "ops";
  async function login(role = "operator", person = "ops") {
    currentOperator = person;
    for (let attempt = 0; attempt < 3; attempt++) {
      await navigate(consoleOrigin + "/login"); await until("document.querySelector('#login-form')?.hidden===false");
      await type("#token", role === "operator" ? operatorTokens.get(person) : role); await click("#login-form button");
      await until(`location.origin===${JSON.stringify(consoleOrigin)}&&location.pathname==='/'&&document.readyState==='complete'||document.querySelector('[data-notice="rate"]')?.hidden===false`);
      if (await evaluate("location.pathname==='/'")) return;
      assert.equal(await evaluate("document.getElementById('token').value"), "");
      // Login and step-up share the production bucket. The no-screenshot lane reaches its
      // limit sooner, so honor the actual retry interval before a fresh explicit submission.
      await sleep(limiter.retryAfterSec() * 1000 + 100);
    }
    assert.fail("The production sign-in limiter did not admit a fresh attempt after its retry interval");
  }

  const launchUrl = (id = runId, kind = "drive") => `${consoleOrigin}/sandbox/gateway/launch?${new URLSearchParams({ host, id, ...(kind === "watch" ? { kind } : {}) })}`;
  let ctaLaunches = 0, watchCtaLaunches = 0, previousIntent = null;
  const freshAuthorize = () => `document.readyState==='complete'&&location.origin===${JSON.stringify(consoleOrigin)}&&location.pathname==='/sandbox/gateway/authorize'&&document.querySelector('[data-sandbox-gateway-mode]')?.getAttribute('data-sandbox-gateway-mode')==='authorize'&&/^[A-Za-z0-9_-]{43}$/.test(new URLSearchParams(location.search).get('intent')||'')&&new URLSearchParams(location.search).get('intent')!==${JSON.stringify(previousIntent)}&&document.getElementById('gateway-step-up')?.hidden===false`;
  async function launch(theme = "light", width = 1440, { id = runId, kind = "drive", expectedRefusal = null, expectFailedAdmission = false } = {}) {
    const ready = `!!document.querySelector('.wb-pane[data-active=true][data-state=ready][data-kind=${kind}]')&&document.querySelector('.wb-pane[data-active=true] [data-terminal-status]')?.textContent===${JSON.stringify(kind === "watch" ? "Watching" : "Connected")}`;
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await tab.send("Page.navigate", { url: consoleOrigin + "/sandbox/gateway/return" });
    await until(`location.origin===${JSON.stringify(consoleOrigin)}&&location.pathname==='/runs/sandboxes'&&document.readyState==='complete'&&document.body.getAttribute('data-page')==='sandboxes'`);
    await evaluate(`document.cookie='pd_theme=${theme}; Path=/; SameSite=Lax'`);
    let sourceTab = null, sourcePath = null, nativeBefore = null;
    if (ctaLaunches < 2 && kind === "drive" && id === runId || kind === "watch" && watchCtaLaunches < 2 && !expectedRefusal) {
      sourcePath = kind === "watch" ? watchCtaLaunches === 0 ? "/run" : "/runs/sandboxes" : ctaLaunches === 0 ? "/runs/sandboxes" : "/run";
      await tab.send("Page.navigate", { url: `${consoleOrigin}${sourcePath}?${new URLSearchParams({ id: runId, ...(sourcePath === "/runs/sandboxes" ? { host } : {}) })}` });
      const ctaSelector = kind === "watch" ? ".sandbox-watch" : ".sandbox-browser";
      await until(`document.querySelector(${JSON.stringify(ctaSelector)})?.getClientRects().length`);
      const nativeSnapshot = "JSON.stringify({path:location.pathname,links:[...document.querySelectorAll('a[href^=\"pi-dispatch-open:\"]')].map(a=>a.href),commands:[...document.querySelectorAll('[data-sandbox-command]')].map(e=>e.textContent)})";
      nativeBefore = await evaluate(nativeSnapshot);
      const native = JSON.parse(nativeBefore); assert.ok(native.links.length && native.commands.length, `${sourcePath} preserves its native opener and marked selectable command (${native.links.length} links, ${native.commands.length} commands)`);
      if (sourcePath === "/run") await captureDocument(`run-workspace-${kind}-${theme}-${width}`);
      for (const href of native.links) parseSandboxOpenUrl(href);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(ctaSelector)}).href`), launchUrl(id, kind));
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(ctaSelector)}).target`), "_blank");
      assert.ok(await evaluate(`document.querySelector(${JSON.stringify(ctaSelector)}).relList.contains('noopener')`));
      assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
      sourceTab = tab;
      const created = browser.event((m) => m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.targetId !== sourceTab.targetId, "rendered browser CTA creates its own tab");
      await click(ctaSelector);
      const { targetId } = (await created).params.targetInfo;
      tab = await attachTab(targetId);
      await initializeTab();
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      if (kind === "watch") watchCtaLaunches++; else ctaLaunches++;
      await until(freshAuthorize());
      assert.equal(await evaluate("window.opener"), null, "the terminal tab cannot control its console opener");
      const original = await sourceTab.send("Runtime.evaluate", { expression: nativeSnapshot, returnByValue: true });
      assert.equal(original.result.value, nativeBefore, "opening the browser leaves the source page and every native opener/command unchanged");
      await sourceTab.close();
    } else {
      await tab.send("Page.navigate", { url: launchUrl(id, kind) });
      // Typed or bookmarked, so not from a console page: nothing is spent until a person says so.
      await until("document.querySelector('#gateway-continue')?.getClientRects().length");
      await click("#gateway-continue");
    }
    await until(freshAuthorize());
    previousIntent = await evaluate("new URLSearchParams(location.search).get('intent')");
    assert.ok(await evaluate(`document.getElementById('gateway-target').textContent.includes(${JSON.stringify(id)})&&document.getElementById('gateway-target').textContent.includes(${JSON.stringify(host)})`));
    assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
    const consoleHeaders = await evaluate("fetch(location.href,{cache:'no-store'}).then(r=>Object.fromEntries(r.headers))");
    assert.equal(consoleHeaders["content-security-policy"], SECURITY_HEADERS["content-security-policy"]);
    await capture(`step-up-${theme}-${width}`);
    assert.equal(await evaluate("innerWidth"), width, "Capture must preserve the real browser viewport");
    for (let attempt = 0; attempt < 3; attempt++) {
      await type("#gateway-token", operatorTokens.get(currentOperator)); await click("#gateway-authorize");
      await until(`location.origin===${JSON.stringify(gatewayOrigin)}&&${ready}||document.getElementById('gateway-status')?.textContent.includes('Too many verification attempts')${expectedRefusal ? `||window.__gatewayReplies?.some(r=>r.refused===${JSON.stringify(expectedRefusal)})` : ''}${expectFailedAdmission ? `||location.origin===${JSON.stringify(gatewayOrigin)}&&document.getElementById('gateway-state')?.hidden===false` : ''}`);
      if (expectFailedAdmission && await evaluate(`location.origin===${JSON.stringify(gatewayOrigin)}&&document.getElementById('gateway-state')?.hidden===false`)) {
        assert.equal(await evaluate("document.querySelectorAll('.wb-pane[data-state=ready]').length"), 0, "a failed admission leaves no terminal");
        return { failed: await evaluate("document.getElementById('gateway-state-title').textContent") };
      }
      if (expectedRefusal && await evaluate(`window.__gatewayReplies?.some(r=>r.refused===${JSON.stringify(expectedRefusal)})`)) {
        assert.equal(await evaluate("document.getElementById('gateway-token').value"), "");
        await capture(`watch-refused-${expectedRefusal}-${theme}`);
        return { refused: expectedRefusal };
      }
      if (await evaluate(`location.origin===${JSON.stringify(gatewayOrigin)}`)) break;
      assert.equal(await evaluate("document.getElementById('gateway-token').value"), "");
      await capture(`rate-limited-${theme}`);
      // Respect the real production token bucket; do not replace its limiter or move its clock for the paint matrix.
      await sleep(limiter.retryAfterSec() * 1000 + 100);
    }
    assert.equal(await evaluate(`location.origin===${JSON.stringify(gatewayOrigin)}&&${ready}`), true);
    assert.equal(await evaluate("location.hash"), "");
  }
  if (tls) {
    stage = "TLS negative control";
    const badCertificate = await gatewayTestCertificate(join(work, "untrusted-tls"), [TLS_UNTRUSTED_HOST]);
    const badPort = await port(), badInner = createHttpServer((_req, res) => res.end("UNTRUSTED_CERTIFICATE_MUST_NOT_LOAD"));
    tlsFronts.push(await gatewayTlsFront(badInner, badPort, badCertificate));
    const control = await browser.openTarget(); await control.send("Page.enable");
    const denied = await control.send("Page.navigate", { url: `https://${TLS_UNTRUSTED_HOST}:${badPort}/` });
    assert.match(denied.errorText ?? "", /ERR_CERT_AUTHORITY_INVALID/, "Only the generated fixture certificate is trusted; unrelated self-signed certificates still fail");
    await control.close();
    stage = "sibling-domain cookie fixation negative control";
    const siblingPort = await port(), sibling = createHttpServer((_req, res) => {
      res.setHeader("set-cookie", [`pdg_browser=${siblingNonce}; Domain=other-browser.test; Path=/; Secure; HttpOnly; SameSite=Strict`, `__Host-pdg_browser=${siblingNonce}; Domain=other-browser.test; Path=/; Secure; HttpOnly; SameSite=Strict`]);
      res.end("Sibling cookie fixture");
    });
    tlsFronts.push(await gatewayTlsFront(sibling, siblingPort, certificate));
    await navigate(`https://${TLS_SIBLING_HOST}:${siblingPort}/`);
    const seeded = (await tab.send("Network.getAllCookies")).cookies;
    assert.ok(seeded.some(c => c.name === "pdg_browser" && c.value === siblingNonce && c.domain === ".other-browser.test"), "the negative control actually planted a domain-scoped legacy cookie");
    assert.ok(!seeded.some(c => c.name === "__Host-pdg_browser"), "the browser rejects a sibling's prefixed Domain cookie before first bootstrap");
  }
  stage = "sign-in"; await login();
  if (tls) {
    assert.equal(await evaluate("isSecureContext"), true);
    const stored = (await tab.send("Network.getAllCookies")).cookies;
    assert.equal(stored.find(c=>c.name==='pdc_session'&&c.domain===TLS_CONSOLE_HOST)?.secure, true);
  }
  for (const theme of ["light", "dark"]) for (const width of [800, 1024, 1440]) {
    stage = `terminal ${theme} ${width}`; await launch(theme, width);
    if (tls) {
      const bound = (await tab.send("Network.getAllCookies")).cookies.find(c => c.name === "__Host-pdg_browser" && c.domain === TLS_GATEWAY_HOST);
      assert.ok(bound?.secure && bound.httpOnly && bound.path === "/", "HTTPS binds only the browser-enforced host cookie");
      assert.ok(bound.value !== siblingNonce, "bootstrap never migrates a sibling's known legacy nonce");
    }
    const headers = await evaluate("fetch(location.href,{cache:'no-store'}).then(r=>Object.fromEntries(r.headers))");
    assert.equal(headers["content-security-policy"], gatewayHeaders(gatewayOrigin)["content-security-policy"]);
    assert.equal(await evaluate("document.documentElement.getAttribute('data-theme')"), theme);
    assert.equal(await evaluate("document.fonts.status"), "loaded");
    assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"));
    await type(".xterm-helper-textarea", "printf '\\033[32mGATEWAY_REAL_\\342\\234\\223_\\347\\225\\214\\033[0m\\n'\n");
    await until("[...document.querySelectorAll('.xterm-rows>div')].map(e=>e.textContent).join(' ').includes('GATEWAY_REAL_✓_界')");
    // Real command editing: backspace changes a command before it reaches the shell.
    await type(".xterm-helper-textarea", "printf 'EDIT_X");
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await type(".xterm-helper-textarea", "Y\\n'\n");
    await until("[...document.querySelectorAll('.xterm-rows>div')].some(e=>e.textContent.trim()==='EDIT_Y')");
    const boxes = await evaluate("(()=>{const rect=q=>{const r=document.querySelector(q).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}};return{terminal:rect('.wb-terminal'),screen:rect('.xterm-screen'),scroll:rect('.xterm-scrollable-element'),pane:rect('.wb-pane')}})()");
    for (const rect of [boxes.screen, boxes.scroll]) {
      assert.ok(rect.left >= boxes.terminal.left - 1 && rect.right <= boxes.terminal.right + 1 && rect.top >= boxes.terminal.top - 1 && rect.bottom <= boxes.terminal.bottom + 1 && rect.bottom <= boxes.pane.bottom + 1, `Pinned FitAddon stays inside its actual terminal and inside its pane: ${JSON.stringify(boxes)}`);
    }
    const viewportPaint = await evaluate("({viewport:getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor,owner:getComputedStyle(document.querySelector('.wb-terminal')).backgroundColor,focus:getComputedStyle(document.querySelector('.xterm-viewport')).boxShadow})");
    assert.equal(viewportPaint.viewport, viewportPaint.owner, "The actual xterm viewport inset uses the reference surface colour");
    assert.notEqual(viewportPaint.focus, "none", "Keyboard focus is visibly drawn above the viewport");
    await capture(`terminal-${theme}-${width}`);
    assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
    await click(".wb-pane[data-active=true] [data-terminal-disconnect]"); await until("document.querySelector('.wb-pane[data-active=true][data-state=ended]')");
    assert.equal(await evaluate("document.querySelector('.wb-pane[data-active=true] [data-terminal-status]').textContent"), "Disconnected", "a dead terminal stops saying Connected");
    assert.ok(await evaluate("document.querySelector('.wb-pane[data-active=true] [data-terminal-return]').getClientRects().length"), "and offers the way back");
    await sleep(200);
    const current = JSON.parse((await exec(bin, ["inspect", name])).stdout)[0]; assert.equal(current.Id, registration.containerId); assert.equal(current.State.Running, true);
    await capture(`disconnected-${theme}-${width}`);
    if (theme === "light" && width === 800) {
      await tab.send("Page.reload");
      await until("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title'))?.textContent==='This launch has ended'");
      await capture("expired-light-800");
      // Coming back to a finished launch, by history, reconnects nothing, whether Chrome reloads it or restores it.
      const connectsBeforeBack = requests.filter(r => r.url === "/api/connect").length;
      const entries = await tab.send("Page.getNavigationHistory");
      await tab.send("Page.navigate", { url: consoleOrigin + "/sandbox/gateway/return" });
      await until(`location.origin===${JSON.stringify(consoleOrigin)}&&document.readyState==='complete'`);
      await tab.send("Page.navigateToHistoryEntry", { entryId: entries.entries[entries.currentIndex].id });
      await until(`location.origin===${JSON.stringify(gatewayOrigin)}&&document.readyState==='complete'&&document.getElementById('gateway-state')?.hidden===false`);
      assert.equal(await evaluate("document.querySelectorAll('.wb-pane[data-state=ready]').length"), 0, "history restores no terminal");
      assert.equal(requests.filter(r => r.url === "/api/connect").length, connectsBeforeBack, "history redeems nothing");
    }
  }
  stage = "hostile output and keyboard"; await launch();
  for (let n = 0; n < 24; n++) {
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 800 + n * 15, height: 1400, deviceScaleFactor: 1, mobile: false });
    await sleep(60);
  }
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  assert.equal(await evaluate("!!document.querySelector('.wb-pane[data-active=true][data-state=ready]') && document.querySelector('.wb-pane[data-active=true] [data-terminal-status]').textContent==='Connected'"), true, "A real sustained desktop resize remains attached: " + await evaluate("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title')).textContent+': '+(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-text]')||document.getElementById('gateway-state-text')).textContent"));
  stage = "alternate screen";
  await type(".xterm-helper-textarea", "printf 'NORMAL_BUFFER_READY\\n'\n");
  await until("[...document.querySelectorAll('.xterm-rows>div')].some(e=>e.textContent.trim()==='NORMAL_BUFFER_READY')");
  await type(".xterm-helper-textarea", "printf '\\033[?1049hALT_SCREEN_READY\\n'\n");
  await until("[...document.querySelectorAll('.xterm-rows>div')].some(e=>e.textContent.trim()==='ALT_SCREEN_READY')");
  assert.ok(!await evaluate("[...document.querySelectorAll('.xterm-rows>div')].some(e=>e.textContent.includes('NORMAL_BUFFER_READY'))"));
  await capture("alternate-screen-light");
  await type(".xterm-helper-textarea", "printf '\\033[?1049l'\n");
  await until("[...document.querySelectorAll('.xterm-rows>div')].some(e=>e.textContent.trim()==='NORMAL_BUFFER_READY')");
  stage = "hostile output";
  const title = await evaluate("document.title"), originalRequests = requests.length;
  await type(".xterm-helper-textarea", "printf '\\033]0;EVIL_TITLE\\007\\033]52;c;RVZJTA==\\007\\033]8;;https://evil.invalid/\\007EVIL_LINK\\033]8;;\\007\\n'\n");
  await until("[...document.querySelectorAll('.xterm-rows>div')].map(e=>e.textContent).join(' ').includes('EVIL_LINK')");
  assert.equal(await evaluate("document.title"), title);
  assert.equal(await evaluate("document.querySelectorAll('.xterm-screen a').length"), 0);
  assert.ok(!requests.slice(originalRequests).some((r) => r.url.includes("evil")));
  // Tab can leave the terminal; literal Escape/Ctrl-C remain available to applications.
  await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.ok(!await evaluate("document.activeElement?.matches('.xterm-helper-textarea')"));
  await type(".xterm-helper-textarea", "sleep 30\n"); await sleep(200);
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 });
  await type(".xterm-helper-textarea", "printf CTRL_C_READY\\n\n");
  await until("[...document.querySelectorAll('.xterm-rows>div')].map(e=>e.textContent).join(' ').includes('CTRL_C_READY')");
  stage = "phone resize";
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await until("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title')).textContent==='Use your own terminal'");
  assert.equal(await evaluate("document.querySelectorAll('.xterm').length"), 0);
  await capture("phone-fallback");
  await sleep(200); assert.equal(JSON.parse((await exec(bin, ["inspect", name])).stdout)[0].State.Running, true);
  stage = "revocation"; await launch("dark"); file.generation++;
  await until("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title')).textContent==='Operator session ended'", 6500);
  assert.equal(await evaluate("document.querySelectorAll('.xterm').length"), 0); await capture("revoked-dark");
  assert.equal(JSON.parse((await exec(bin, ["inspect", name])).stdout)[0].State.Running, true);
  stage = "roles and read-only";
  const opened = () => audits.filter((kind) => kind === "open").length;
  const opensBeforeRefusals = opened();
  for (const role of ["viewer", "agent"]) {
    await login(role); await tab.send("Page.navigate", { url: launchUrl() });
    await until("document.getElementById('gateway-status')?.textContent.includes('operator on a writable console')");
    assert.equal(await evaluate("document.getElementById('gateway-token').disabled"), true);
    await capture(`console-${role}-refused`);
  }
  await login(); config.readOnly = true;
  await tab.send("Page.navigate", { url: launchUrl() });
  await until("document.getElementById('gateway-status')?.textContent.includes('operator on a writable console')");
  await capture("console-read-only"); config.readOnly = false;
  assert.equal(opened(), opensBeforeRefusals, "Disallowed roles never reach runtime attachment");
  for (const theme of ["light", "dark"]) {
    stage = `phone and no-JavaScript ${theme}`;
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 1000, deviceScaleFactor: 1, mobile: true });
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await tab.send("Page.navigate", { url: launchUrl() });
    await until("document.getElementById('gateway-phone')&&!document.getElementById('gateway-phone').hidden");
    await evaluate(`document.cookie='pd_theme=${theme}; Path=/; SameSite=Lax'`);
    await tab.send("Page.reload");
    await until("document.getElementById('gateway-phone')&&!document.getElementById('gateway-phone').hidden");
    await capture(`console-phone-${theme}`);
    const postsBefore = requests.filter((r) => r.method === "POST").length;
    await navigate(gatewayOrigin + "/s/" + randomBytes(32).toString("base64url"));
    await until("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title')).textContent==='Use your own terminal'");
    assert.equal(requests.filter((r) => r.method === "POST").length, postsBefore, "Direct phone entry cannot consume a grant");
    await capture(`gateway-phone-${theme}`);
    await tab.send("Emulation.setScriptExecutionDisabled", { value: true });
    await navigate(consoleOrigin + "/sandbox/gateway/authorize?intent=" + randomBytes(32).toString("base64url"));
    assert.equal(await evaluate("document.getElementById('gateway-token').disabled"), true);
    assert.ok(await evaluate("document.body.innerText.includes('need JavaScript')"));
    await capture(`console-no-js-${theme}`);
    await navigate(gatewayOrigin + "/s/" + randomBytes(32).toString("base64url"));
    assert.ok(await evaluate("document.body.innerText.includes('JavaScript is required')"));
    assert.equal(await evaluate("!document.querySelector('.wb-pane[data-state=ready]')"), true);
    await capture(`gateway-no-js-${theme}`);
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
  }
  stage = "read-only transition"; await launch("dark"); config.readOnly = true;
  await until("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title')).textContent==='Operator session ended'", 6500);
  await capture("read-only-transition-dark"); config.readOnly = false;
  assert.equal(ctaLaunches, 2, "both Sandboxes and Run use their actual rendered own-tab CTA");
  stage = "four actual sandbox terminals";
  const additional = [];
  for (let index = 1; index <= 3; index++) additional.push(await extraShell(index));
  await launch("dark");
  const owner = tab;
  const paneSelector = id => `.wb-pane[data-sandbox-id="${id}"]`;
  const textOf = id => `[...document.querySelectorAll(${JSON.stringify(paneSelector(id) + " .xterm-rows>div")})].map(e=>e.textContent).join(String.fromCharCode(10))`;
  const hasLine = (id, line) => `[...document.querySelectorAll(${JSON.stringify(paneSelector(id) + " .xterm-rows>div")})].some(e=>e.textContent.trim()===${JSON.stringify(line)})`;
  const selectPane = async id => {
    const local = await evaluate(`document.querySelector(${JSON.stringify(paneSelector(id))})?.dataset.pane`);
    assert.ok(local, "an authorized target has a pane");
    if (!await evaluate(`document.querySelector('[data-terminal-select="${local}"]')?.getClientRects().length`)) await click('[data-wb-action="rail"]');
    await click(`[data-terminal-select="${local}"]`);
    await until(`document.querySelector(${JSON.stringify(paneSelector(id))})?.dataset.active==='true'&&document.querySelector(${JSON.stringify(paneSelector(id))})?.dataset.visible==='true'&&document.querySelector(${JSON.stringify(paneSelector(id) + ' .xterm-helper-textarea')})?.readOnly===false`);
  };
  const admitInto = async (workspaceTab, targetId, { kind = "drive", count } = {}) => {
    tab = workspaceTab; browser = workspaceTab.browser;
    const activeBefore = await evaluate("document.querySelector('.wb-pane[data-active=true]')?.dataset.pane");
    const socketsBefore = await evaluate("window.__gatewaySockets.length");
    const repliesBefore = await evaluate("window.__gatewayReplies.filter(r=>r.path==='/api/connect').length");
    await evaluate("window.__gatewayOriginalTerminal=document.querySelector('.wb-pane[data-active=true] .xterm')");
    const created = browser.event(m => m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.targetId !== workspaceTab.targetId, "Add another creates its selector helper");
    await click('[data-wb-action="add"]');
    tab = await attachTab((await created).params.targetInfo.targetId); await initializeTab();
    await until(`location.origin===${JSON.stringify(consoleOrigin)}&&location.pathname==='/runs/sandboxes'&&new URLSearchParams(location.search).get('gatewaySelect')==='1'`);
    const pickUrl = new URL(launchUrl(targetId, kind));
    const chosen = `.sandbox-browser[href="${pickUrl.pathname}${pickUrl.search}"]`;
    await until(`document.querySelector(${JSON.stringify(chosen)})?.getClientRects().length`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(chosen)}).target`), "_self", "selection continues in the proof-owning helper");
    await click(chosen); await until(freshAuthorize());
    const helper = tab;
    tab = workspaceTab; browser = workspaceTab.browser;
    if (kind === "drive") {
      const currentId = await evaluate("document.querySelector('.wb-pane[data-active=true]').dataset.sandboxId");
      const liveMarker = `STEPUP_${targetId}`;
      await type(paneSelector(currentId) + " .xterm-helper-textarea", `printf '${liveMarker}\\n'\n`);
      await until(hasLine(currentId, liveMarker));
    }
    tab = helper;
    previousIntent = await evaluate("new URLSearchParams(location.search).get('intent')");
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = browser.event(m => m.method === "Network.responseReceived" && m.sessionId === helper.sessionId && m.params.response.url === consoleOrigin + "/api/sandbox-gateway/authorize", "helper authorization response");
      await type("#gateway-token", operatorTokens.get(currentOperator)); await click("#gateway-authorize");
      const status = (await response).params.response.status;
      if (status !== 429) { assert.equal(status, 200, "the current helper step-up must succeed before transfer"); break; }
      assert.equal(await evaluate("document.getElementById('gateway-token').value"), "");
      await sleep(limiter.retryAfterSec() * 1000 + 100);
      assert.ok(attempt < 2, "the production limiter must eventually admit a fresh helper submission");
    }
    tab = workspaceTab; browser = workspaceTab.browser;
    await until(`window.__gatewayReplies.filter(r=>r.path==='/api/connect').length>${repliesBefore}&&document.querySelectorAll('.wb-pane[data-state=ready]').length===${count}`, 15000);
    assert.equal(await evaluate("document.querySelector('.wb-pane[data-active=true]')?.dataset.pane"), activeBefore, "a background admission never steals focus");
    assert.equal(await evaluate("document.querySelector('.wb-pane[data-active=true] .xterm')===window.__gatewayOriginalTerminal"), true, "existing xterm DOM survives the handoff");
    assert.equal(await evaluate("window.__gatewaySockets.length"), socketsBefore + (kind === "watch" ? 0 : 1), "only a new distinct terminal creates a socket; a duplicate watch focuses its owner");
  };
  stage = "a helper tab that crashes costs the workspace nothing";
  {
    const created = browser.event(m => m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.targetId !== owner.targetId, "Add another creates its helper");
    await click('[data-wb-action="add"]');
    const helper = await attachTab((await created).params.targetInfo.targetId);
    // Crash only once it has left the owner's initial blank document: until then it may share the owner's process,
    // and that would be testing Chrome's process model rather than this workspace.
    await helper.send("Runtime.enable");
    for (let attempt = 0; ; attempt++) {
      const here = await helper.send("Runtime.evaluate", { expression: "location.origin", returnByValue: true }).then(r => r.result.value, () => null);
      if (here === consoleOrigin) break;
      assert.ok(attempt < 200, "the helper reaches the console to choose a terminal");
      await sleep(30);
    }
    void helper.send("Page.crash").catch(() => {}); // A crash never answers.
    await sleep(500); await helper.close().catch(() => {});
    tab = owner; browser = owner.browser;
    await type(".wb-pane[data-active=true] .xterm-helper-textarea", "printf 'SURVIVES_HELPER_CRASH\\n'\n");
    await until("[...document.querySelectorAll('.wb-pane[data-active=true] .xterm-rows>div')].some(e=>e.textContent.trim()==='SURVIVES_HELPER_CRASH')");
    assert.equal(await evaluate("document.querySelector('[data-wb-action=add]').getAttribute('aria-disabled')"), "false", "a crashed helper leaves no slot behind");
  }
  stage = "four actual sandbox terminals";
  for (let index = 0; index < additional.length; index++) await admitInto(owner, additional[index].id, { count: index + 2 });
  const ids = [runId, ...additional.map(shell => shell.id)];
  const opensBeforeLayout = opened();
  const socketsBeforeLayout = await evaluate("window.__gatewaySockets.length");
  await evaluate("window.__gatewayNodes=[...document.querySelectorAll('.wb-pane')].map(e=>({id:e.dataset.sandboxId,node:e.querySelector('.xterm')}))");
  for (const id of ids) {
    await selectPane(id);
    const marker = `ONLY_${id}`;
    await type(paneSelector(id) + " .xterm-helper-textarea", `printf '${marker}\\n'\n`);
    await until(hasLine(id, marker));
    for (const other of ids.filter(candidate => candidate !== id)) assert.equal(await evaluate(`${textOf(other)}.includes(${JSON.stringify(marker)})`), false, "typing is isolated to its selected sandbox");
  }
  await selectPane(ids[1]); await click('[data-wb-action="split-right"]');
  await selectPane(ids[2]); await click('[data-wb-action="split-below"]');
  await until("document.querySelectorAll('.dv-groupview').length>=3");
  await click('[data-wb-action="narrower"]'); await click('[data-wb-action="wider"]');
  await click('[data-wb-action="shorter"]'); await click('[data-wb-action="taller"]');
  await click('[data-wb-action="move-left"]'); await click('[data-wb-action="move-right"]');
  assert.equal(await evaluate("window.__gatewayNodes.every(({id,node})=>document.querySelector('.wb-pane[data-sandbox-id=\"'+id+'\"] .xterm')===node)"), true, "all terminals preserve identity through actual layout controls");
  assert.equal(await evaluate("window.__gatewaySockets.length"), socketsBeforeLayout);
  assert.equal(opened(), opensBeforeLayout, "layout changes create no runtime attachment or audit open");
  // Before the sweep below: a narrow width collapses splits, and they deliberately never come back by themselves.
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  for (const theme of ["light", "dark"]) {
    for (let attempt = 0; attempt < 3 && await evaluate("document.documentElement.getAttribute('data-theme')") !== theme; attempt++) await click("#wb-theme");
    await capture(`workbench-split-${theme}-1440`);
  }
  for (const theme of ["dark", "light"]) {
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    for (let attempt = 0; attempt < 3 && await evaluate("document.documentElement.getAttribute('data-theme')") !== theme; attempt++) await click("#wb-theme");
    await until(`document.documentElement.getAttribute('data-theme')===${JSON.stringify(theme)}`);
    for (const width of [1920, 1440, 1024, 800, 761]) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      await until("[...document.querySelectorAll('.wb-pane[data-visible=true]')].every(p=>p.dataset.state==='ready')");
      assert.equal(await evaluate("window.__gatewaySockets.filter(s=>s.readyState===1).length"), 4);
      assert.equal(await evaluate("document.querySelectorAll('.wb-pane[data-state=ended]').length"), 0);
      assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1"));
      assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
      await capture(`workbench-four-${theme}-${width}`);
    }
  }
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await selectPane(runId);
  assert.ok(await evaluate(`document.querySelector('#wb-context').textContent.includes(${JSON.stringify(runId)})`));
  assert.ok(await evaluate(`document.querySelector('#wb-return').href.includes(${JSON.stringify(encodeURIComponent(runId))})`));
  stage = "opt-in watching in independent operator browsers";
  assert.equal(await evaluate("document.querySelector('#wb-watch-policy').checked"), false);
  await click("#wb-watch-policy");
  await until("document.querySelector('#wb-watch-policy').checked&&!document.querySelector('#wb-watch-policy').disabled");
  const watchers = [];
  for (const person of ["lee", "sam", "kim"]) {
    await isolatedTab(); await login("operator", person);
    await launch("dark", 1024, { kind: "watch" });
    watchers.push({ person, tab });
    assert.equal(await evaluate("document.querySelector('.wb-pane[data-active=true]').dataset.kind"), "watch");
    assert.equal(await evaluate("document.querySelector('#wb-tab-focus')?.getClientRects().length||0"), 0);
    assert.ok(await evaluate("document.querySelector('.wb-pane[data-active=true] [data-terminal-disconnect]').textContent.includes('Stop watching')"));
    await capture(`watch-${person}-dark-1024`);
  }
  tab = owner; browser = owner.browser; currentOperator = "ops";
  await until("document.querySelectorAll('#wb-roster [data-watcher-name]').length===3");
  for (const person of ["lee", "sam", "kim"]) assert.ok(await evaluate(`document.querySelector('#wb-roster [data-watcher-name=${person}]')?.getClientRects().length`));
  await selectPane(ids[1]);
  assert.equal(await evaluate("document.querySelectorAll('#wb-roster [data-watcher-name]').length"), 3, "watchers remain visible while their driver pane is inactive");
  await capture("workbench-hidden-driver-watched-light-1440");
  await selectPane(runId);
  await type(paneSelector(runId) + " .xterm-helper-textarea", "printf 'SHARED_NEW_OUTPUT_\\342\\234\\223_\\347\\225\\214\\n'; stty size\n");
  // `stty size` asks the PTY itself, so this is the driver's real geometry and not what any page claims.
  const sizeLine = `${textOf(runId)}.split(String.fromCharCode(10)).map(l=>l.trim()).reverse().find(l=>/^[0-9]+ [0-9]+$/.test(l))`;
  await until(sizeLine);
  const driverSize = await evaluate(sizeLine), [driverRows, driverCols] = driverSize.split(" ").map(Number);
  for (const watcher of watchers) {
    tab = watcher.tab; browser = watcher.tab.browser;
    await until(hasLine(runId, 'SHARED_NEW_OUTPUT_✓_界'));
    await until(hasLine(runId, driverSize));
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(paneSelector(runId) + " .xterm-rows>div")}).length`), driverRows, "a watcher renders exactly the driver's rows");
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(paneSelector(runId) + " .wb-pane-head")}).textContent.includes(${JSON.stringify(`${driverCols} × ${driverRows}`)})`), "the watcher's tab names the driver's real size");
    assert.equal(await evaluate(`${textOf(runId)}.includes('USABLE_DURING_STEPUP')`), false, "late watchers receive no earlier terminal output");
  }
  const WATCH_END_MS = 5500; // The contract's five-second bound, plus the frame's trip back to this page.
  const on = (where, person) => { tab = where; browser = where.browser; currentOperator = person; };
  const watchEnded = title => until(`(document.querySelector('.wb-pane[data-kind=watch][data-state=ended] [data-terminal-state-title]')||document.getElementById('gateway-state-title'))?.textContent===${JSON.stringify(title)}`, WATCH_END_MS);
  const watchOpensBeforeRefusal = opened();
  await isolatedTab(); await login("operator", "pat");
  assert.deepEqual(await launch("light", 1024, { kind: "watch", expectedRefusal: "watch-limit" }), { refused: "watch-limit" });
  assert.equal(opened(), watchOpensBeforeRefusal, "a fourth authorized watcher cannot attach");
  tab = owner; browser = owner.browser; currentOperator = "ops";
  await selectPane(ids[1]);
  await click('#wb-roster [data-watcher-name="sam"] [data-watch-remove]');
  tab = watchers[1].tab;
  await watchEnded("Watching ended");
  tab = watchers[0].tab; currentOperator = "lee";
  await admitInto(tab, runId, { kind: "watch", count: 1 });
  // A hostile watcher writes every capability frame to its real socket. The gateway drops them before the
  // runtime and the watch stays up. The proof is the driver's shell below, never this page's own state.
  await evaluate("(()=>{const s=window.__gatewaySockets.find(s=>s.readyState===1);for(const m of [{type:'input',data:'printf HOSTILE_WATCH_INPUT\\n\\r'},{type:'resize',cols:33,rows:11,width:1440},{type:'activity'}])s.send(JSON.stringify(m));})()");
  await sleep(1500);
  assert.equal(await evaluate("document.querySelector('.wb-pane[data-kind=watch]')?.dataset.state"), "ready", "a dropped frame neither ends the watch nor reaches the shell");
  on(owner, "ops");
  await selectPane(runId);
  assert.equal(await evaluate(`${textOf(runId)}.includes('HOSTILE_WATCH_INPUT')`), false);
  await type(paneSelector(runId) + " .xterm-helper-textarea", "printf 'SIZE_AFTER_HOSTILE '; stty size\n");
  const sizeAfter = `${textOf(runId)}.split(String.fromCharCode(10)).map(l=>l.trim()).reverse().find(l=>/^SIZE_AFTER_HOSTILE [0-9]+ [0-9]+$/.test(l))`;
  await until(sizeAfter);
  // A shrinking roster may have grown this terminal since. The PTY must still agree with the driver's own
  // rendered terminal, and the hostile 11 by 33 must not be what it says.
  const [rowsAfter, colsAfter] = (await evaluate(sizeAfter)).split(" ").slice(1).map(Number);
  assert.equal(rowsAfter, await evaluate(`document.querySelectorAll(${JSON.stringify(paneSelector(runId) + " .xterm-rows>div")}).length`), "the PTY still has the driver's rows");
  assert.notDeepEqual([rowsAfter, colsAfter], [11, 33], "a watcher's resize frame never reaches the PTY");
  // A control frame is not a capability a watcher has, so it is refused outright and the driver's consent stands.
  on(watchers[0].tab, "lee");
  await evaluate("window.__gatewaySockets.find(s=>s.readyState===1).send(JSON.stringify({type:'watch-policy',enabled:false}))");
  await watchEnded("Terminal connection refused");
  on(owner, "ops");
  assert.equal(await evaluate("document.querySelector('#wb-watch-policy').checked"), true, "a watcher's control frame never changes the driver's consent");
  const paneStates = "JSON.stringify([...document.querySelectorAll('.wb-pane')].map(p=>({id:p.dataset.sandboxId,state:p.dataset.state,active:p.dataset.active,visible:p.dataset.visible,title:p.querySelector('[data-terminal-state-title]')?.textContent,box:p.getBoundingClientRect().toJSON()})))";
  // Not "all ready": a hidden pane that was too small during the width sweep re-measures only when shown.
  assert.equal(await evaluate("document.querySelectorAll('.wb-pane[data-state=ended]').length"), 0, "a watcher's frames end no other pane: " + await evaluate(paneStates));
  assert.equal(await evaluate("window.__gatewaySockets.filter(s=>s.readyState===1).length"), 4, "and close no other socket: " + await evaluate(paneStates));
  await click("#wb-watch-policy");
  tab = watchers[2].tab;
  await watchEnded("Watching was turned off");
  on(owner, "ops");
  await type(paneSelector(runId) + " .xterm-helper-textarea", "printf 'DRIVER_AFTER_WATCHES\\n'\n");
  await until(hasLine(runId, 'DRIVER_AFTER_WATCHES'));
  await selectPane(ids[3]); await click('[data-wb-action="close"]');
  await until("document.querySelectorAll('.wb-pane').length===3&&document.querySelectorAll('.wb-pane[data-state=ended]').length===0");
  assert.equal(JSON.parse((await exec(bin, ["inspect", additional[2].containerId])).stdout)[0].State.Running, true, "closing a pane only detaches");
  assert.equal(watchCtaLaunches, 2, "Run and Sandboxes both provide a working Watch handoff");
  // Each launch below navigates out first, which detaches the workspace; the original native shells remain.
  const freshDriver = async () => {
    on(owner, "ops"); await launch("dark"); await click("#wb-watch-policy");
    await until("document.querySelector('#wb-watch-policy').checked&&!document.querySelector('#wb-watch-policy').disabled");
  };
  const watchAs = async (index, options) => { on(watchers[index].tab, watchers[index].person); return launch("dark", 1024, { kind: "watch", ...options }); };
  const rosterHas = async person => { on(owner, "ops"); await until(`document.querySelector('#wb-roster [data-watcher-name=${person}]')`); };

  stage = "a watch ends with its driver";
  await freshDriver(); await watchAs(0); await rosterHas("lee");
  await click(".wb-pane[data-active=true] [data-terminal-disconnect]");
  on(watchers[0].tab, "lee"); await watchEnded("The driver disconnected");

  stage = "a watch ends with its own operator's authority, and its driver stays";
  await freshDriver();
  await watchAs(0); await rosterHas("lee");
  const withoutToken = person => { const entry = file.tokens.find(t => t.name === person); file.tokens.splice(file.tokens.indexOf(entry), 1); return () => file.tokens.push(entry); };
  const restoreLee = withoutToken("lee");
  on(watchers[0].tab, "lee"); await watchEnded("Operator session ended");
  restoreLee();
  on(owner, "ops");
  await until("!document.querySelector('#wb-roster [data-watcher-name=lee]')", WATCH_END_MS);
  await type(".wb-pane[data-active=true] .xterm-helper-textarea", "printf 'DRIVER_OUTLIVES_WATCHER\\n'\n");
  await until("[...document.querySelectorAll('.xterm-rows>div')].some(e=>e.textContent.trim()==='DRIVER_OUTLIVES_WATCHER')");

  stage = "a watch ends with its driver's authority, and its own session survives";
  await watchAs(1); await rosterHas("sam");
  const restoreOps = withoutToken("ops");
  await until("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title'))?.textContent==='Operator session ended'", WATCH_END_MS);
  on(watchers[1].tab, "sam"); await watchEnded("The driver disconnected");
  restoreOps();
  on(owner, "ops"); await login();

  // The real pinned pi in a workbench pane, offline and with no credentials. Its prompt is a draft, never sent.
  // The rootless lane may run a plain shell image: it says so instead of quietly passing.
  const pinnedPi = JSON.parse(fs.readFileSync(new URL("../../image/runner/package.json", import.meta.url), "utf8")).dependencies["@earendil-works/pi-coding-agent"];
  const piBin = "/app/node_modules/.bin/pi";
  const hasPi = await exec(bin, ["exec", name, "test", "-x", piBin]).then(() => true, () => false);
  if (venue === "local") assert.ok(hasPi, "the Docker lane runs the job image, so its pi must be there");
  if (!hasPi) console.log(`Gateway browser ${venue}: ${process.env.PI_JOB_IMAGE} has no pi, so the pi TUI stage did not run on this lane.`);
  for (const theme of hasPi ? ["dark", "light"] : []) {
    stage = `the real pi TUI in a workbench pane, ${theme}`;
    on(owner, "ops"); await launch(theme, 1440);
    const pane = ".wb-pane[data-active=true]", area = `${pane} .xterm-helper-textarea`, rows = `[...document.querySelectorAll(${JSON.stringify(pane + " .xterm-rows>div")})].map(e=>e.textContent).join(String.fromCharCode(10))`;
    await type(area, `env -i PATH=/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin HOME=/home/pi TERM=xterm-256color PI_CODING_AGENT_DIR=/tmp/pi-browser-example PI_TELEMETRY=0 PI_OFFLINE=1 pi --offline --no-session --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --no-tools --tui-mode fullscreen --use-theme ${theme}\n`);
    await until(`${rows}.includes(${JSON.stringify(`v${pinnedPi}`)})`, 20000);
    await sleep(800);
    await type(area, "Inspect this repository. (Draft, not submitted)");
    await until(`${rows}.includes('Draft, not submitted')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pane + " [data-terminal-status]")}).textContent`), "Connected");
    assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
    await capture(`workbench-pi-tui-${theme}-1440`);
    for (const [letter, code, vk] of [["c", "KeyC", 67], ["d", "KeyD", 68]]) {
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: letter, code, windowsVirtualKeyCode: vk, modifiers: 2 });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: letter, code, windowsVirtualKeyCode: vk, modifiers: 2 });
      await sleep(300);
    }
    await type(area, "printf 'PI_EXITED_TO_BASH\\n'\n");
    await until(`${rows}.split(String.fromCharCode(10)).some(l=>l.trim()==='PI_EXITED_TO_BASH')`);
  }

  // Last before the external end, because the page stays hidden after a CDP freeze: its animation frames stop,
  // so nothing that types into this tab can follow it.
  stage = "a frozen driver admits no watcher";
  await freshDriver();
  const opensBeforeFrozen = audits.filter(kind => kind === "opening").length;
  await owner.send("Page.setWebLifecycleState", { state: "frozen" });
  await watchAs(0, { expectFailedAdmission: true });
  assert.equal(audits.filter(kind => kind === "opening").length, opensBeforeFrozen, "with no rendered roster, a watcher never reaches the runtime");
  await owner.send("Page.setWebLifecycleState", { state: "active" });
  // Chrome may drop a frozen page's socket. If it did, the honest result is an ended pane that replays nothing;
  // that the gateway itself does not punish a slow driver is held by gateway/test/two-process.test.mjs.
  on(owner, "ops");
  await until("(s=>s==='ready'||s==='ended')(document.querySelector('.wb-pane[data-active=true]')?.dataset.state)");

  stage = "external sandbox end"; on(owner, "ops"); await launch("light");
  await exec(bin, ["rm", "-f", ...(venue === "podman" ? ["--time=0"] : []), name]);
  await until("(document.querySelector('.wb-pane[data-active=true] [data-terminal-state-title]')||document.getElementById('gateway-state-title')).textContent==='Sandbox ended'", 6500);
  await capture("sandbox-ended-light");
  for (const logsDir of [config.logsDir, join(work, "gateway-logs")]) {
    const directory = join(logsDir, "console-audit");
    const raw = fs.readdirSync(directory).filter((n) => n.endsWith(".jsonl")).map((n) => fs.readFileSync(join(directory, n), "utf8")).join("");
    for (const privateText of [...operatorTokens.values(), "GATEWAY_REAL", "EVIL_TITLE", "EVIL_LINK", "SHARED_NEW_OUTPUT", "HOSTILE_WATCH_INPUT"]) assert.ok(!raw.includes(privateText), "Audit contains safe metadata only");
  }
  assert.ok(requests.every((r) => !r.cookieNames.includes("pdc_session")), "gateway never receives the console cookie");
  assert.ok(requests.every((r) => !/handoff|tabProof|token|#/.test(r.url)), "proofs and tokens never enter gateway request URLs");
  assert.ok(audits.includes("opening") && audits.includes("open") && audits.includes("end"));
  if (tls) {
    const stored = (await tab.send("Network.getAllCookies")).cookies;
    assert.equal(stored.find(c=>c.name==='__Host-pdg_browser'&&c.domain===TLS_GATEWAY_HOST)?.secure, true);
    assert.equal(await evaluate("isSecureContext"), true);
  }
  console.log(`Gateway browser ${venue} ${tls ? "TLS" : "HTTP loopback"}: real two-site step-up, xterm I/O/edit/Unicode/keyboard, 6 theme-width renders, safe output, detach, roles, phone, no-JavaScript, revocation, four terminals, three watchers in separate browsers, every watch ending, a frozen driver, the real pi TUI in a pane and external end passed.`);
} catch (error) {
  console.error(`Failed in stage: ${stage}`);
  throw error;
} finally {
  clearInterval(renewer);
  for (const openedBrowser of allBrowsers) await openedBrowser.close().catch(() => {});
  for (const child of children) child.kill("SIGKILL");
  await gateway?.close().catch(() => {});
  await broker?.close().catch(() => {});
  if (consoleServer?.listening) { consoleServer.closeAllConnections(); await new Promise((r) => consoleServer.close(r)); }
  for (const front of tlsFronts) await front.close().catch(() => {});
  if (redis) {
    if (registration) await releaseSandboxSession(redis, registration).catch(() => {});
    for (const shell of extraShells) await releaseSandboxSession(redis, shell).catch(() => {});
    const keys = await redis.keys(prefix + "*").catch(() => []); if (keys.length) await redis.del(...keys).catch(() => {});
    redis.disconnect();
  }
  await exec(bin, ["rm", "-f", ...(venue === "podman" ? ["--time=0"] : []), name]).catch(() => {});
  for (const shell of extraShells) await exec(bin, ["rm", "-f", ...(venue === "podman" ? ["--time=0"] : []), shell.containerId]).catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
