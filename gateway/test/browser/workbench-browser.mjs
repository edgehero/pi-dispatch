/** Real Dockview/xterm DOM, keyboard and resize regression. Authority/runtime use the separate live TLS oracle. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { openChrome } from "../../../launch/chrome-pipe.mjs";
import { findChrome, chromeLaunchArgs } from "../../../.github/scripts/console-width-check.mjs";
import { gatewayPage } from "../../src/page.mjs";
import { gatewayHeaders } from "../../src/server.mjs";
import { buildGatewayAssets } from "../../build.mjs";
import { tempDir } from "../helpers/temp-dir.mjs";
const here = fileURLToPath(new URL("../../", import.meta.url));
const fixture = `
import {Terminal} from '@xterm/xterm';import {FitAddon} from '@xterm/addon-fit';import {createDockview} from 'dockview';
import {mountGateway} from '${here}src/browser.mjs';import {mountWorkbench} from '${here}src/workbench.mjs';
window.__csp=[];addEventListener('securitypolicyviolation',e=>__csp.push(e.violatedDirective));
const sockets=[];class Socket extends EventTarget{constructor(){super();this.readyState=0;this.bufferedAmount=0;this.sent=[];this.kind=window.__fixture?.nextKind||"drive";sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));if(this.kind==='watch')this.frame({type:'geometry',cols:120,rows:36,revision:0});else this.frame({type:'sharing',enabled:false,revision:0,watchers:[]});this.frame({type:'ready'});});}frame(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}output(text){this.dispatchEvent(new MessageEvent('message',{data:new TextEncoder().encode(text).buffer}));}send(data){this.sent.push(JSON.parse(data));}close(){this.readyState=3;}}
window.WebSocket=Socket;
const wb=await mountWorkbench({window,document,createDockview,mountTerminal:o=>mountGateway({...o,Terminal,FitAddon})});
const connection=(n,kind='drive')=>({connectionId:String(n).repeat(43),sessionKey:'a'.repeat(64),targetKey:String(n).repeat(64),ownerKey:'b'.repeat(63)+n,kind,host:'mini1',id:'gh-'+n,by:'ops',idleMinutes:30,theme:'dark',runFacts:null,...(kind==='watch'?{driver:{name:'lee',ownerKey:'c'.repeat(64)},geometry:{cols:120,rows:36,revision:0}}:{})});
window.__fixture={wb,sockets,admit:(n,kind="drive")=>{window.__fixture.nextKind=kind;return wb.admit(connection(n,kind));},output:(n,text)=>sockets[n].output(text)};
await wb.admit(connection(1));window.__fixture.ready=true;
`;
const assets = await buildGatewayAssets();
const built = await build({ stdin: { contents: fixture, sourcefile: "workbench-fixture.mjs", resolveDir: here }, bundle: true, write: false, format: "esm", platform: "browser", target: "chrome100", logLevel: "silent" });
const html = gatewayPage({ consoleOrigin: "http://console.example.test" }).replace('<script src="/static/gateway.js" defer></script>', '<script src="/fixture.js" type="module"></script>');
let browser; const children = new Set(), server = createServer((req, res) => {
	for (const [key, value] of Object.entries(gatewayHeaders(`http://127.0.0.1:${server.address().port}`))) res.setHeader(key, value);
	res.setHeader("content-type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/static/gateway.css" ? "text/css" : "text/html");
	res.end(req.url === "/fixture.js" ? built.outputFiles[0].text : req.url === "/static/gateway.css" ? assets.css : html);
});
try {
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const chrome = findChrome(); assert.ok(chrome.path, "Pinned Chrome is required for the DOM regression");
	browser = await openChrome({ chrome: chrome.path, work: tempDir("pd-workbench-dom-"), children, env: { HOME: process.env.HOME }, extraArgs: [...chromeLaunchArgs({ sandbox: process.env.GITHUB_ACTIONS !== "true" }), "--window-size=1600,1600"], resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" });
	const tab = await browser.openTarget(); await tab.send("Page.enable"); await tab.send("Runtime.enable");
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	const evaluate = async expression => { const r = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const until = async expression => { const end = performance.now() + 12000; while (performance.now() < end) { if (await evaluate(expression)) return; await sleep(20); } throw Error("DOM regression timed out: " + expression + " " + await evaluate("JSON.stringify({focus:document.activeElement.className,panes:[...document.querySelectorAll('.wb-pane')].map(p=>({id:p.getAttribute('data-pane'),state:p.getAttribute('data-state'),active:p.getAttribute('data-active'),visible:p.getAttribute('data-visible'),rect:p.getBoundingClientRect().toJSON(),screen:p.querySelector('.xterm-screen')?.getBoundingClientRect().toJSON(),readonly:p.querySelector('textarea')?.readOnly}))})")); };
	const click = async selector => { const p = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();if(b.width<=0||b.height<=0)throw Error("Control is not visible");return{x:b.x+b.width/2,y:b.y+b.height/2};})()`); for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, ...p, button: "left", clickCount: 1 }); };
	await tab.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/s/${"i".repeat(43)}` });
	await until("window.__fixture?.ready===true");
	await evaluate("window.__originalNode=document.querySelector('[data-pane=\"p1\"]');window.__originalEditor=document.querySelector('.xterm-helper-textarea')");
	await until("document.querySelector('[data-pane=\"p1\"]').getAttribute('data-state')==='ready'");
	await click('#wb-focus-terminal');
	await until("document.activeElement===window.__originalEditor");
	await evaluate("__fixture.admit(2)");
	assert.equal(await evaluate("document.activeElement===window.__originalEditor"), true, "background ready retains the original input focus");


	if (await evaluate("document.querySelector('[data-wb-action=rail]').getAttribute('aria-expanded')==='false'")) await click('[data-wb-action="rail"]');
	await click('[data-terminal-select="p2"]');
	assert.equal(await evaluate("document.querySelector('[data-pane=\"p1\"]').getAttribute('aria-hidden')"), null);
	await evaluate("__fixture.output(0,'\\x1b[6n')");
	await until("__fixture.sockets[0].sent.some(m=>m.type==='input'&&/R$/.test(m.data))");
	assert.equal(await evaluate("__fixture.sockets[0].sent.some(m=>m.type==='activity')"), false, "real hidden xterm CPR never reports human activity");
	await click('[data-wb-action="split-right"]');
	await until("document.querySelectorAll('.dv-groupview').length===2");
	assert.equal(await evaluate("document.querySelector('[data-pane=\"p1\"]')===window.__originalNode"), true);
	await click('[data-wb-action="wider"]'); await click('[data-wb-action="narrower"]');
	await click('[data-wb-action="merge"]'); await until("document.querySelectorAll('.dv-groupview').length===1");
	assert.equal(await evaluate("__fixture.sockets.length"), 2, "splits, resize and merge do not create transports");
	await click('[data-terminal-select="p1"]');
	await click('[data-wb-action="move-right"]');
	assert.equal(await evaluate("document.querySelector('[data-pane=\"p1\"]')===window.__originalNode"), true);
	// APG community tab keys operate on the actual vendor tablist, without paid keyboard options.
	await evaluate("document.querySelector('[role=tab]').focus()");
	const before = await evaluate("document.activeElement.textContent");
	for (const type of ["keyDown", "keyUp"]) await tab.send("Input.dispatchKeyEvent", { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
	assert.notEqual(await evaluate("document.activeElement.textContent"), before);
	for (const theme of ["light", "dark"]) {
		await evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)})`);
		for (const width of [800, 1024, 1440]) {
			await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
			await until("document.documentElement.scrollWidth<=innerWidth");
			assert.equal(await evaluate("getComputedStyle(document.body).getPropertyValue('--canvas').trim()"), theme === "light" ? "#edeeec" : "#000000");
		}
	}

	await evaluate("__fixture.admit(3)"); await evaluate("__fixture.admit(4)");
	if (await evaluate("document.querySelector('[data-wb-action=rail]').getAttribute('aria-expanded')==='false'")) await click('[data-wb-action="rail"]');
	for (let n = 1; n <= 4; n++) {
		await click(`[data-terminal-select="p${n}"]`);
		await until(`(()=>{const e=document.querySelector('[data-pane="p${n}"] .xterm-helper-textarea');return e&&!e.readOnly&&document.activeElement===e})()`);
		const before = await evaluate("__fixture.sockets.map(s=>s.sent.length)"), typed = `printf_MARK_${n}`;
		for (const character of typed) {
			assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-pane="p${n}"] .xterm-helper-textarea')`), true, "focus remains with the selected terminal during every key");
			const virtual = /^[a-z0-9]$/i.test(character) ? character.toUpperCase().charCodeAt(0) : 0;
			await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: character, windowsVirtualKeyCode: virtual });
			await tab.send("Input.dispatchKeyEvent", { type: "char", key: character, text: character, unmodifiedText: character, windowsVirtualKeyCode: virtual });
			await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: character, windowsVirtualKeyCode: virtual });
			await sleep(20);
		}
		for (let socket = 0; socket < 4; socket++) assert.equal(await evaluate(`__fixture.sockets[${socket}].sent.slice(${before[socket]}).filter(m=>m.type==='input').map(m=>m.data).join('')`), socket === n - 1 ? typed : "", "the complete typed prefix reaches only its selected terminal");
	}
	await click('[data-terminal-select="p2"]');

	assert.equal(await evaluate("document.querySelector('[data-pane=\"p2\"]').getAttribute('data-active')"), "true");
	await click('[data-wb-action="close"]');
	assert.equal(await evaluate("__fixture.sockets[0].readyState"), 1); assert.equal(await evaluate("__fixture.sockets[1].readyState"), 3);
	assert.equal(await evaluate("document.querySelector('[data-pane=\"p1\"]')===window.__originalNode"), true);
	await evaluate("__fixture.admit(5,'watch')");
	await click('[data-terminal-select="p5"]');
	await until("(()=>{const e=document.querySelector('[data-pane=\"p5\"] .xterm-screen');return e&&e.getBoundingClientRect().width>900&&e.getBoundingClientRect().height>600})()");
	await until("document.querySelector('[data-pane=\"p5\"] [data-terminal-output]')===document.activeElement");
	assert.equal(await evaluate("document.getElementById('wb-tab-label').hidden"), true);
	assert.equal(await evaluate("document.getElementById('wb-watch-label').hidden"), true);
	await evaluate("__fixture.output(4,'\\x1b[6n')"); await sleep(100);
	assert.deepEqual(await evaluate("__fixture.sockets[4].sent"), [], "a newly shown background watch remeasures locally but sends no CPR, input or PTY resize");
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 1000, deviceScaleFactor: 1, mobile: false });
	await until("document.documentElement.scrollWidth<=innerWidth");
	assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-pane=\"p5\"] [data-terminal-output]')).overflowX"), "auto");

	// From here on only the keyboard moves things: nothing below dispatches a pointer event.
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	const press = async (key, code, vk, extra = {}) => { await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, ...extra }); await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }); };
	const groups = () => evaluate("document.querySelectorAll('.dv-groupview').length");
	const socketsBeforeKeyboard = await evaluate("__fixture.sockets.length");
	await evaluate("document.querySelector('[data-wb-action=rail]').focus()");
	const reached = new Set();
	for (let n = 0; n < 24; n++) { reached.add(await evaluate("document.activeElement.getAttribute('data-wb-action')||document.activeElement.id||document.activeElement.className")); await press("Tab", "Tab", 9); }
	for (const control of ["split-right", "split-below", "move-left", "move-right", "close"]) assert.ok(reached.has(control), `Tab reaches ${control}: ${[...reached].join()}`);
	const enter = async action => { await evaluate(`document.querySelector('[data-wb-action="${action}"]').focus()`); await press("Enter", "Enter", 13, { text: "\r" }); };
	const startingGroups = await groups();
	await enter("split-right");
	await until(`document.querySelectorAll('.dv-groupview').length===${startingGroups + 1}`);
	await enter("narrower"); await enter("wider"); await enter("shorter"); await enter("taller");
	await enter("merge");
	await until("document.querySelectorAll('.dv-groupview').length===1");
	const order = "[...document.querySelectorAll('[role=tab]')].map(t=>t.textContent).join()";
	const orderBefore = await evaluate(order);
	// A tab already at the left end has nowhere to go, so start with the direction that really moves it.
	const atStart = await evaluate("document.querySelector('[role=tab][aria-selected=true]')===document.querySelector('[role=tab]')");
	await enter(atStart ? "move-right" : "move-left");
	assert.notEqual(await evaluate(order), orderBefore, "the keyboard really moved the tab");
	await enter(atStart ? "move-left" : "move-right");
	assert.equal(await evaluate(order), orderBefore, "and moving it back returns it to its place");
	assert.equal(await evaluate("__fixture.sockets.length"), socketsBeforeKeyboard, "keyboard layout changes make no new transport");

	// Home and End on the vendor's own tablist.
	await evaluate("document.querySelector('[role=tab]').focus()");
	await press("End", "End", 35);
	assert.equal(await evaluate("document.activeElement===[...document.querySelectorAll('[role=tab]')].at(-1)"), true, "End goes to the last tab");
	await press("Home", "Home", 36);
	assert.equal(await evaluate("document.activeElement===document.querySelector('[role=tab]')"), true, "Home goes to the first tab");

	// What a screen reader is given, from the browser's own accessibility tree.
	await tab.send("Accessibility.enable");
	// A pane reports visible one frame before Dockview unhides its overlay, so read the tree after that frame.
	const tree = async () => (await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"), await tab.send("Accessibility.getFullAXTree")).nodes.filter(n => !n.ignored).map(n => ({ role: n.role?.value, name: n.name?.value ?? "" }));
	const select = async pane => { await evaluate(`document.querySelector('[data-terminal-select="${pane}"]').focus()`); await press("Enter", "Enter", 13, { text: "\r" }); await until(`document.querySelector('[data-pane="${pane}"]').dataset.active==='true'&&document.querySelector('[data-pane="${pane}"]').dataset.visible==='true'`); };
	await select("p1");
	const driving = await tree();
	assert.equal(driving.filter(n => ["button", "link", "checkbox", "tab", "combobox"].includes(n.role) && !n.name.trim()).map(n => n.role).join(), "", "every control has a name");
	assert.ok(driving.some(n => n.role === "tablist"), "the tabs are a tablist");
	assert.ok(driving.some(n => n.role === "button" && n.name === "Split right"));
	assert.ok(driving.some(n => n.role === "checkbox" && /operators watch/i.test(n.name)), "the watching switch is a named checkbox");
	assert.ok(driving.some(n => n.role === "textbox" && /Terminal input for gh-1/.test(n.name)), "a driver's terminal says what it is");
	await select("p5");
	const watching = await tree();
	assert.equal(watching.filter(n => ["button", "link", "checkbox", "tab", "combobox"].includes(n.role) && !n.name.trim()).map(n => n.role).join(), "", "every control has a name while watching too");
	assert.ok(watching.some(n => n.role === "button" && /Stop watching/.test(n.name)), "a watcher can stop");
	assert.ok(!watching.some(n => n.role === "checkbox" && /operators watch/i.test(n.name)), "a watcher has no sharing switch");
	assert.ok(watching.some(n => /Read-only output of gh-5/.test(n.name)), "a watch says it cannot be typed into");
	await select("p1");

	// 200% zoom of a 1600 by 1000 window: the layout reflows and nothing runs off the page.
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 500, deviceScaleFactor: 2, mobile: false });
	await until("document.documentElement.scrollWidth<=innerWidth");
	assert.equal(await evaluate("document.querySelector('[data-wb-action=split-right]').getClientRects().length>0"), true);
	assert.equal(await evaluate("__fixture.sockets.filter(s=>s.readyState===1).length"), await evaluate("document.querySelectorAll('.wb-pane').length"), "zoom ends no terminal");

	// Too little room collapses the rail and then the splits. More room later never restores them by itself.
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await until("document.querySelector('[data-wb-action=split-right]')&&!document.querySelector('[data-wb-action=split-right]').disabled");
	await enter("split-right"); await until("document.querySelectorAll('.dv-groupview').length===2");
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 260, deviceScaleFactor: 1, mobile: false });
	await until("document.querySelectorAll('.dv-groupview').length===1&&document.getElementById('wb-notice').textContent.includes('combined')");
	const socketsBeforeRoom = await evaluate("__fixture.sockets.filter(s=>s.readyState===1).length");
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await sleep(400);
	assert.equal(await groups(), 1, "splits never come back on their own");
	assert.equal(await evaluate("__fixture.sockets.filter(s=>s.readyState===1).length"), socketsBeforeRoom, "collapsing keeps every connection");

	assert.deepEqual(await evaluate("window.__csp"), []);
	assert.equal(await evaluate("document.fonts.status"), "loaded");
	await evaluate("__fixture.wb.dispose()");
	console.log("Workbench DOM: real Dockview/xterm, background focus, hidden CPR, split/resize/merge/reorder, keyboard-only layout, Home/End, the accessibility tree, zoom, collapse without restore, two themes, three widths and close isolation passed under the actual gateway CSP.");
} finally {
	await browser?.close().catch(() => {}); for (const child of children) child.kill("SIGKILL");
	server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
