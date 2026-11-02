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
const venue = process.env.PI_SANDBOX_GATEWAY_VENUE ?? "local", bin = venue === "podman" ? "podman" : "docker";
assert.ok(["local", "podman"].includes(venue));
assert.ok(process.env.PI_JOB_IMAGE, "PI_JOB_IMAGE must name an already-built pinned job image");
assert.ok(process.env.VALKEY_TEST_URL, "VALKEY_TEST_URL must name an isolated live test control store");
assert.ok(process.env.PI_SANDBOX_GATEWAY_SOCKET, "PI_SANDBOX_GATEWAY_SOCKET must name the actual local runtime socket");
const chrome = findChrome(); assert.ok(chrome.path, "a real Chrome is required");
const work = fs.mkdtempSync(join(tmpdir(), "pd-gateway-browser-")), children = new Set();
const runId = `sb-${randomBytes(16).toString("hex")}`, host = `browser-${randomBytes(8).toString("hex")}`, nonce = randomBytes(16).toString("hex");
const name = sandboxContainerName(runId), token = `pdc_${randomBytes(32).toString("base64url")}`;
const prefix = `gateway-browser-${randomBytes(8).toString("hex")}:`;
let redis, consoleServer, gateway, browser, broker, registration, renewer, stage = "startup";
const audits = [], requests = [], tlsFronts = [];
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
  renewer = setInterval(() => { void renewSandboxSession(redis, registration).catch(() => {}); }, 1000);
  const consolePort = await port(), gatewayPort = await port();
  // Different sites, not merely different ports: Strict cookies are genuinely withheld on both return GETs.
  const consoleOrigin = tls ? `https://${TLS_CONSOLE_HOST}:${consolePort}` : `http://localhost:${consolePort}`;
  const gatewayOrigin = tls ? `https://${TLS_GATEWAY_HOST}:${gatewayPort}` : `http://127.0.0.1:${gatewayPort}`;
  const certificate = tls ? await gatewayTestCertificate(join(work, "tls"), [TLS_CONSOLE_HOST, TLS_GATEWAY_HOST]) : null;
  const config = { dir: work, allowedHosts: tls ? [TLS_CONSOLE_HOST] : [], readOnly: false, maxMs: 3600000, logsDir: join(work, "console-logs") };
  const file = { version: 1, generation: 0, tokens: ["operator", "viewer", "agent"].map((role) => ({ name: role === "operator" ? "ops" : role, role, sha256: sha(role === "operator" ? token : role) })) };
  const sessions = cookies.makeSessionStore();
  const store = makeGatewayStore({ redis, prefix });
  const audit = makeConsoleAudit({ logsDir: config.logsDir });
  const journal = makeGatewayAudit({ logsDir: join(work, "gateway-logs") }); journal.recover();
  const registry = { config: { version: 1, consoleOrigin, hosts: { [host]: { origin: gatewayOrigin } } }, digest: "browser-fixture" };
  broker = makeGatewayBroker({ redis, store, sessions, readTokens: () => ({ file }), findToken, readRegistry: () => registry, audit, readOnly: () => config.readOnly, readSessions: () => readSandboxSessions(redis, { hosts: [host] }) });
  const limiter = makeLoginLimiter({ now: () => Date.now() });
  // Real page rendering reads the same live registration as the broker. Only retained inventory is a fixture;
  // the clicked CTA still goes through production step-up, store, audit, lease and runtime admission below.
  const inventory = sandboxFixture(Date.now());
  inventory.hosts = [{ ...inventory.hosts[0], name: host, rows: [{ ...inventory.hosts[0].rows[0], id: runId, v: venue }] }];
  inventory.selected.host = host;
  const liveShells = () => readSandboxSessions(redis, { hosts: [host] });
  const pageDeps = {
    fleet: { parkedCount: async () => 0, runById: async (id) => ({ source: "local", record: { jobId: id, host, backend: venue, kind: "github", target: "acme/web#490", flow: "fix", outcome: "completed", startedAt: new Date(registration.since - 3600000).toISOString(), endedAt: new Date(registration.since - 1800000).toISOString() } }) },
    sandboxes: { hosts: () => ({ config: { version: 1, hosts: { [host]: { target: `ops@${host}`, deployment: "/srv/pi", nodePath: "/usr/bin/node", cliPath: "/srv/pi/node_modules/@edgehero/pi-dispatch/src/cli.mjs" } } } }), read: async () => ({ ...inventory, sessions: (await liveShells()).sessions }) },
    gatewayView: async () => ({ enabledHosts: Object.keys(registry.config.hosts), sessions: (await liveShells()).sessions }),
  };
  consoleServer = createConsoleServer({ limiter, config, sessions, cookies, tickets: makeConfirmTickets(), readTokens: () => ({ file }), findToken, audit, gateway: broker, consoleOrigin: () => consoleOrigin, pageDeps });
  if (tls) tlsFronts.push(await gatewayTlsFront(consoleServer, consolePort, certificate));
  else await new Promise((r) => consoleServer.listen(consolePort, "0.0.0.0", r));
  const gatewayConfig = { origin: gatewayOrigin, consoleOrigin, host, sockets: { [venue]: process.env.PI_SANDBOX_GATEWAY_SOCKET }, idleMinutes: 30 };
  gateway = createGatewayServer({ config: gatewayConfig, store, runtime: makeGatewayRuntime({ sockets: gatewayConfig.sockets }), assets: await buildGatewayAssets(), audit: async (...values) => { audits.push(values[0]); return journal.record(...values); } });
  if (tls) tlsFronts.push(await gatewayTlsFront(gateway.server, gatewayPort, certificate));
  else await new Promise((r) => gateway.server.listen(gatewayPort, "127.0.0.1", r));
  gateway.server.prependListener("request", (req) => { requests.push({ method: req.method, url: req.url, cookieNames: String(req.headers.cookie ?? "").split(";").map((p) => p.trim().split("=")[0]) }); });
  browser = await openChrome({ chrome: chrome.path, work, children, env: { HOME: process.env.HOME }, extraArgs: [...chromeLaunchArgs({ sandbox: process.env.GITHUB_ACTIONS !== "true" }), "--window-size=1600,1600", ...(tls ? [`--ignore-certificate-errors-spki-list=${certificate.spki}`] : [])], resolverRules: tls ? `MAP ${TLS_CONSOLE_HOST} 127.0.0.1, MAP ${TLS_GATEWAY_HOST} 127.0.0.1, MAP ${TLS_UNTRUSTED_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` : "MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", captureStderr: true });
  let tab = await browser.openTarget();
  const initializeTab = async () => { await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__gatewayResizes=[];addEventListener('resize',()=>window.__gatewayResizes.push({width:innerWidth,height:innerHeight,at:performance.now()}));window.__gatewayCsp=[];addEventListener('securitypolicyviolation',e=>window.__gatewayCsp.push(e.violatedDirective+':'+e.blockedURI));" }); };
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
    const diagnostic = await evaluate("JSON.stringify({url:location.origin+location.pathname,status:document.getElementById('gateway-status')?.textContent,state:document.getElementById('gateway-state-text')?.textContent,width:innerWidth,resizes:window.__gatewayResizes,terminal:[...document.querySelectorAll('.xterm-rows>div')].map(e=>e.textContent).join(' / ').slice(-1000)})");
    if (shots) { fs.mkdirSync(shots, { recursive: true }); const debug = await tab.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }); fs.writeFileSync(join(shots, "debug-failure.png"), Buffer.from(debug.data, "base64")); }
    throw new Error(`${stage}: timed out waiting for ${expression}; ` + diagnostic);
  };
  const navigate = async (url) => { await tab.send("Page.navigate", { url }); await until(`document.readyState==='complete'&&location.href===${JSON.stringify(url)}`); };
  const click = async (selector) => {
    const box = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
  };
  const type = async (selector, text) => {
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control on '+location.pathname+' state '+document.getElementById('gateway-state-title')?.textContent+' '+document.getElementById('gateway-state-text')?.textContent);e.focus();${selector.includes("xterm") ? "" : "e.select?.();"}})()`);
    if (!selector.includes("xterm")) { await tab.send("Input.insertText", { text }); return; }
    // xterm's pinned screen-reader mode intentionally ignores input-only IME events. Drive actual key events.
    for (const character of text) {
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
    fs.writeFileSync(join(shots, name + ".probe.json"), JSON.stringify(await evaluate("({width:innerWidth,height:innerHeight,canvas:getComputedStyle(document.body).getPropertyValue('--canvas').trim(),fontStatus:document.fonts.status,font:getComputedStyle(document.body).fontFamily,sheets:[...document.styleSheets].map(s=>({href:s.href,rules:s.cssRules.length})),boxes:Object.fromEntries(['.gw-terminal','.xterm','.xterm-screen','.xterm-scrollable-element','.gw-terminal-foot'].map(q=>{const e=document.querySelector(q),r=e?.getBoundingClientRect(),c=e&&getComputedStyle(e);return[q,r?{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,box:c.boxSizing,padding:c.padding,scroll:e.scrollHeight}:null]})),formHidden:document.getElementById('gateway-step-up')?.hidden,resizes:window.__gatewayResizes})"), null, 2));
  };
  async function login(role = "operator") {
    await navigate(consoleOrigin + "/login"); await until("document.querySelector('#login-form')&&!document.querySelector('#login-form').hidden");
    await type("#token", role === "operator" ? token : role); await click("#login-form button"); await until(`location.origin===${JSON.stringify(consoleOrigin)}&&location.pathname==='/'`);
  }
  const launchUrl = () => `${consoleOrigin}/sandbox/gateway/launch?${new URLSearchParams({ host, id: runId })}`;
  let ctaLaunches = 0;
  async function launch(theme = "light", width = 1440) {
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await tab.send("Page.navigate", { url: consoleOrigin + "/sandbox/gateway/return" });
    await until(`location.origin===${JSON.stringify(consoleOrigin)}&&location.pathname==='/runs/sandboxes'`);
    await evaluate(`document.cookie='pd_theme=${theme}; Path=/; SameSite=Lax'`);
    let sourceTab = null, sourcePath = null, nativeBefore = null;
    if (ctaLaunches < 2) {
      sourcePath = ctaLaunches === 0 ? "/runs/sandboxes" : "/run";
      await tab.send("Page.navigate", { url: `${consoleOrigin}${sourcePath}?${new URLSearchParams({ id: runId, ...(sourcePath === "/runs/sandboxes" ? { host } : {}) })}` });
      await until("document.querySelector('.sandbox-browser')?.getClientRects().length");
      const nativeSnapshot = "JSON.stringify({path:location.pathname,links:[...document.querySelectorAll('a[href^=\"pi-dispatch-open:\"]')].map(a=>a.href),commands:[...document.querySelectorAll('[data-sandbox-command]')].map(e=>e.textContent)})";
      nativeBefore = await evaluate(nativeSnapshot);
      const native = JSON.parse(nativeBefore); assert.ok(native.links.length && native.commands.length);
      for (const href of native.links) parseSandboxOpenUrl(href);
      assert.equal(await evaluate("document.querySelector('.sandbox-browser').href"), launchUrl());
      assert.equal(await evaluate("document.querySelector('.sandbox-browser').target"), "_blank");
      assert.ok(await evaluate("document.querySelector('.sandbox-browser').relList.contains('noopener')"));
      assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
      sourceTab = tab;
      const created = browser.event((m) => m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.targetId !== sourceTab.targetId, "rendered browser CTA creates its own tab");
      await click(".sandbox-browser");
      const { targetId } = (await created).params.targetInfo;
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      tab = { targetId, sessionId, send: (method, params, ms) => browser.send(method, params, sessionId, ms), close: () => browser.send("Target.closeTarget", { targetId }) };
      await initializeTab();
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      ctaLaunches++;
      await until("location.pathname==='/sandbox/gateway/authorize'&&document.getElementById('gateway-step-up')&&!document.getElementById('gateway-step-up').hidden");
      assert.equal(await evaluate("window.opener"), null, "the terminal tab cannot control its console opener");
      const original = await sourceTab.send("Runtime.evaluate", { expression: nativeSnapshot, returnByValue: true });
      assert.equal(original.result.value, nativeBefore, "opening the browser leaves the source page and every native opener/command unchanged");
      await sourceTab.close();
    } else await tab.send("Page.navigate", { url: launchUrl() });
    await until(`location.origin===${JSON.stringify(consoleOrigin)}&&location.pathname==='/sandbox/gateway/authorize'&&!document.getElementById('gateway-step-up').hidden`);
    assert.ok(await evaluate(`document.getElementById('gateway-target').textContent.includes(${JSON.stringify(runId)})&&document.getElementById('gateway-target').textContent.includes(${JSON.stringify(host)})`));
    assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
    const consoleHeaders = await evaluate("fetch(location.href,{cache:'no-store'}).then(r=>Object.fromEntries(r.headers))");
    assert.equal(consoleHeaders["content-security-policy"], SECURITY_HEADERS["content-security-policy"]);
    await capture(`step-up-${theme}-${width}`);
    assert.equal(await evaluate("innerWidth"), width, "Capture must preserve the real browser viewport");
    for (let attempt = 0; attempt < 3; attempt++) {
      await type("#gateway-token", token); await click("#gateway-authorize");
      await until(`location.origin===${JSON.stringify(gatewayOrigin)}&&document.getElementById('gateway-connection')?.textContent==='Connected'||document.getElementById('gateway-status')?.textContent.includes('Too many verification attempts')`);
      if (await evaluate(`location.origin===${JSON.stringify(gatewayOrigin)}`)) break;
      assert.equal(await evaluate("document.getElementById('gateway-token').value"), "");
      await capture(`rate-limited-${theme}`);
      // Respect the real production token bucket; do not replace its limiter or move its clock for the paint matrix.
      await sleep(limiter.retryAfterSec() * 1000 + 100);
    }
    assert.equal(await evaluate(`location.origin===${JSON.stringify(gatewayOrigin)}&&document.getElementById('gateway-connection')?.textContent==='Connected'`), true);
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
  }
  stage = "sign-in"; await login();
  if (tls) {
    assert.equal(await evaluate("isSecureContext"), true);
    const stored = (await tab.send("Network.getAllCookies")).cookies;
    assert.equal(stored.find(c=>c.name==='pdc_session'&&c.domain===TLS_CONSOLE_HOST)?.secure, true);
  }
  for (const theme of ["light", "dark"]) for (const width of [800, 1024, 1440]) {
    stage = `terminal ${theme} ${width}`; await launch(theme, width);
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
    const boxes = await evaluate("(()=>{const rect=q=>{const r=document.querySelector(q).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}};return{terminal:rect('.gw-terminal'),screen:rect('.xterm-screen'),scroll:rect('.xterm-scrollable-element'),footer:rect('.gw-terminal-foot')}})()");
    for (const rect of [boxes.screen, boxes.scroll]) {
      assert.ok(rect.left >= boxes.terminal.left - 1 && rect.right <= boxes.terminal.right + 1 && rect.top >= boxes.terminal.top - 1 && rect.bottom <= boxes.terminal.bottom + 1 && rect.bottom <= boxes.footer.top + 1, `Pinned FitAddon stays inside its actual terminal and above the footer: ${JSON.stringify(boxes)}`);
    }
    const viewportPaint = await evaluate("({viewport:getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor,owner:getComputedStyle(document.querySelector('.gw-terminal')).backgroundColor,focus:getComputedStyle(document.querySelector('.xterm-viewport')).boxShadow})");
    assert.equal(viewportPaint.viewport, viewportPaint.owner, "The actual xterm viewport inset uses the reference surface colour");
    assert.notEqual(viewportPaint.focus, "none", "Keyboard focus is visibly drawn above the viewport");
    await capture(`terminal-${theme}-${width}`);
    assert.deepEqual(await evaluate("window.__gatewayCsp"), []);
    await click("#gateway-disconnect"); await until("!document.getElementById('gateway-state').hidden");
    await sleep(200);
    const current = JSON.parse((await exec(bin, ["inspect", name])).stdout)[0]; assert.equal(current.Id, registration.containerId); assert.equal(current.State.Running, true);
    await capture(`disconnected-${theme}-${width}`);
    if (theme === "light" && width === 800) {
      await tab.send("Page.reload");
      await until("document.getElementById('gateway-state-title')?.textContent==='This launch has ended'");
      await capture("expired-light-800");
    }
  }
  stage = "hostile output and keyboard"; await launch();
  for (let n = 0; n < 24; n++) {
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 800 + n * 15, height: 1400, deviceScaleFactor: 1, mobile: false });
    await sleep(60);
  }
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  assert.equal(await evaluate("!document.getElementById('gateway-terminal-card').hidden && document.getElementById('gateway-connection').textContent==='Connected'"), true, "A real sustained desktop resize remains attached: " + await evaluate("document.getElementById('gateway-state-title').textContent+': '+document.getElementById('gateway-state-text').textContent"));
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
  await until("document.getElementById('gateway-state-title').textContent==='Use your own terminal'");
  assert.equal(await evaluate("document.querySelectorAll('.xterm').length"), 0);
  await capture("phone-fallback");
  await sleep(200); assert.equal(JSON.parse((await exec(bin, ["inspect", name])).stdout)[0].State.Running, true);
  stage = "revocation"; await launch("dark"); file.generation++;
  await until("document.getElementById('gateway-state-title').textContent==='Operator session ended'", 6500);
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
    await until("document.getElementById('gateway-state-title').textContent==='Use your own terminal'");
    assert.equal(requests.filter((r) => r.method === "POST").length, postsBefore, "Direct phone entry cannot consume a grant");
    await capture(`gateway-phone-${theme}`);
    await tab.send("Emulation.setScriptExecutionDisabled", { value: true });
    await navigate(consoleOrigin + "/sandbox/gateway/authorize?intent=" + randomBytes(32).toString("base64url"));
    assert.equal(await evaluate("document.getElementById('gateway-token').disabled"), true);
    assert.ok(await evaluate("document.body.innerText.includes('need JavaScript')"));
    await capture(`console-no-js-${theme}`);
    await navigate(gatewayOrigin + "/s/" + randomBytes(32).toString("base64url"));
    assert.ok(await evaluate("document.body.innerText.includes('JavaScript is required')"));
    assert.equal(await evaluate("document.getElementById('gateway-terminal-card').hidden"), true);
    await capture(`gateway-no-js-${theme}`);
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
  }
  stage = "read-only transition"; await launch("dark"); config.readOnly = true;
  await until("document.getElementById('gateway-state-title').textContent==='Operator session ended'", 6500);
  await capture("read-only-transition-dark"); config.readOnly = false;
  assert.equal(ctaLaunches, 2, "both Sandboxes and Run use their actual rendered own-tab CTA");
  stage = "external sandbox end"; await launch("light");
  await exec(bin, ["rm", "-f", ...(venue === "podman" ? ["--time=0"] : []), name]);
  await until("document.getElementById('gateway-state-title').textContent==='Sandbox ended'", 6500);
  await capture("sandbox-ended-light");
  for (const logsDir of [config.logsDir, join(work, "gateway-logs")]) {
    const directory = join(logsDir, "console-audit");
    const raw = fs.readdirSync(directory).filter((n) => n.endsWith(".jsonl")).map((n) => fs.readFileSync(join(directory, n), "utf8")).join("");
    for (const privateText of [token, "GATEWAY_REAL", "EVIL_TITLE", "EVIL_LINK"]) assert.ok(!raw.includes(privateText), "Audit contains safe metadata only");
  }
  assert.ok(requests.every((r) => !r.cookieNames.includes("pdc_session")), "gateway never receives the console cookie");
  assert.ok(requests.every((r) => !/handoff|tabProof|token|#/.test(r.url)), "proofs and tokens never enter gateway request URLs");
  assert.ok(audits.includes("opening") && audits.includes("open") && audits.includes("end"));
  if (tls) {
    const stored = (await tab.send("Network.getAllCookies")).cookies;
    assert.equal(stored.find(c=>c.name==='pdg_browser'&&c.domain===TLS_GATEWAY_HOST)?.secure, true);
    assert.equal(await evaluate("isSecureContext"), true);
  }
  console.log(`Gateway browser ${venue} ${tls ? "TLS" : "HTTP loopback"}: real two-site step-up, xterm I/O/edit/Unicode/keyboard, 6 theme-width renders, safe output, detach, roles, phone, no-JavaScript, revocation and external end passed.`);
} finally {
  clearInterval(renewer);
  await browser?.close().catch(() => {});
  for (const child of children) child.kill("SIGKILL");
  await gateway?.close().catch(() => {});
  await broker?.close().catch(() => {});
  if (consoleServer?.listening) { consoleServer.closeAllConnections(); await new Promise((r) => consoleServer.close(r)); }
  for (const front of tlsFronts) await front.close().catch(() => {});
  if (redis) {
    if (registration) await releaseSandboxSession(redis, registration).catch(() => {});
    const keys = await redis.keys(prefix + "*").catch(() => []); if (keys.length) await redis.del(...keys).catch(() => {});
    redis.disconnect();
  }
  await exec(bin, ["rm", "-f", ...(venue === "podman" ? ["--time=0"] : []), name]).catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
