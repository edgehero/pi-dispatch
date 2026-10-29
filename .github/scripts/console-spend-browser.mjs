/**
 * Spend's real-browser behavior checks (#749), run by console-width-check in the same browser and CSP.
 * Unit goldens prove server output; these checks prove the external script wires real SVG and form elements.
 * Allocation HTTP answers are canned here: action planners and writes have their own injected and Valkey tests.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const ensure = (ok, why) => { if (!ok) throw new Error(why); };
const key = async (t, text, code, number) => {
	await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: text, code, windowsVirtualKeyCode: number });
	await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: text, code, windowsVirtualKeyCode: number });
};
async function click(t, evaluate, selector) {
	const at = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:"center",inline:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
	ensure(at, `missing interactive element ${selector}`);
	await t.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at });
	await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at });
}
const paused = `new Promise(resolve => setTimeout(resolve, 120))`;

export async function checkSpendBrowser({ browser, docs, origin, openPage, clockMs, shots }) {
	const results = [];
	const docFor = (page, test = () => true, role = "operator") => docs.find((d) => d.page === page && d.role === role && !d.file.startsWith("panels/") && test(d));
	const run = async (name, doc, check, noScript = false) => {
		const result = { run: { key: `spend-browser-${name}`, doc: doc ?? { id: name, path: name, page: "insights", role: "operator" }, label: "real browser behavior" }, failures: [], notes: [] };
		results.push(result);
		if (!doc) { result.failures.push(`${name}: required Spend fixture is absent`); return; }
		let target;
		try {
			const page = await openPage({ browser, key: name, url: origin + doc.path, metrics: { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, emulated: "light", clockMs, noScript });
			target = page.t;
			await check(page);
			const errors = await page.evaluate(`({csp:window.__pdCsp||[],errors:window.__pdErrors||[]})`);
			ensure(errors.csp.length === 0, `${name}: CSP violation ${JSON.stringify(errors.csp)}`);
			ensure(errors.errors.length === 0, `${name}: page error ${JSON.stringify(errors.errors)}`);
		} catch (e) { result.failures.push(`${name}: ${e.message}`); }
		finally { if (target) await target.close().catch(() => {}); }
	};
	const map = docFor("insights-flows", (d) => d.html.includes('id="graph"'));
	await run("map-controls", map, async ({ t, evaluate }) => {
		const read = () => evaluate(`(() => {const v=document.getElementById("graph").viewBox.baseVal;return {x:v.x,y:v.y,width:v.width,height:v.height};})()`);
		const base = await read();
		await click(t, evaluate, '[data-graph-zoom="in"]');
		ensure((await read()).width < base.width, "Zoom in did not change the SVG viewBox");
		await click(t, evaluate, '[data-graph-zoom="out"]');
		ensure(Math.abs((await read()).width - base.width) < 0.01, "Zoom out did not undo one zoom step");
		await click(t, evaluate, '[data-graph-zoom="fit"]');
		ensure(Math.abs((await read()).width - base.width) < 0.01, "Fit did not restore the initial view");
		const at = await evaluate(`(() => {const e=document.getElementById("graph");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+Math.min(100,r.width/2),y:r.y+Math.min(60,r.height/2)};})()`);
		await t.send("Input.dispatchMouseEvent", { type: "mouseWheel", deltaX: 0, deltaY: -100, ...at });
		await evaluate(paused, true);
		ensure((await read()).width < base.width, "Wheel did not zoom the SVG");
		const beforePan = await read();
		await t.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at });
		await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: at.x + 30, y: at.y + 20 });
		await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: at.x + 30, y: at.y + 20 });
		const afterPan = await read();
		ensure(afterPan.x !== beforePan.x || afterPan.y !== beforePan.y, "Dragging did not pan the SVG");
		await click(t, evaluate, '[data-graph-zoom="fit"]');
		await evaluate(`document.querySelector('[data-graph-zoom="fit"]').focus()`);
		await key(t, "Tab", "Tab", 9);
		ensure(await evaluate(`document.activeElement.matches('.gnode')`), "Tab does not reach the first SVG chip");
		// Select a trigger so the details and URL can be checked against its stable source index.
		await evaluate(`document.querySelector('.gnode[data-trigger-index]').focus()`);
		await key(t, "Enter", "Enter", 13);
		ensure(await evaluate(`(() => {const e=document.activeElement;return e.getAttribute("aria-pressed")==="true" && new URL(location.href).searchParams.get("select")===e.getAttribute("data-trigger-index") && !document.querySelector("[data-selected-details]").hidden && document.querySelector("[data-selected-details]").textContent.trim().length>0;})()`), "Enter did not select a trigger, update its side card and keep its source index in the URL");
		await key(t, "Escape", "Escape", 27);
		ensure(await evaluate(`!document.querySelector('.gnode[aria-pressed="true"]') && document.querySelector('[data-selected-details]').hidden && !new URL(location.href).searchParams.has('select')`), "Escape did not clear selection, details and URL together");
	});
	const selected = docFor("insights-flows", (d) => d.html.includes('aria-pressed="true"'));
	await run("server-selection-without-script", selected, async ({ evaluate }) => {
		ensure(await evaluate(`!!document.querySelector('.gnode[aria-pressed="true"]') && !document.querySelector('[data-selected-details]').hidden`), "The selected chip and side card need JavaScript to appear");
	}, true);
	const list = docFor("insights-flows", (d) => !d.html.includes('id="graph"') && d.html.includes("Flows list"));
	await run("list-without-script", list, async ({ evaluate }) => {
		ensure(await evaluate(`!!document.querySelector('#p-flows table tbody tr') && !document.getElementById('graph-nodes') && !document.getElementById('graph')`), "The list is empty or still embeds map-only node data");
	}, true);
	const spent = docs.find((d) => d.file.endsWith("spend-flows-spent.viewer.html"));
	await run("spent-one-shot-run-link", spent, async ({ evaluate }) => {
		ensure(await evaluate(`(() => {const a=document.querySelector('[data-selected-details] a[href^="/run?"]');if(!a)return false;const u=new URL(a.href);return /^[A-Za-z0-9._:-]{1,200}$/.test(u.searchParams.get('id')||'') && a.textContent.includes('one-shot');})()`), "The spent one-shot's selected card has no validated run link");
	}, true);
	await run("breakdown-deep-link", docFor("insights-breakdown"), async ({ evaluate }) => {
		ensure(await evaluate(`(() => {const a=document.querySelector('#p-breakdown a[href*="/insights/flows?"]');if(!a)return false;const u=new URL(a.href);return u.pathname==='/insights/flows' && /^\\d+$/.test(u.searchParams.get('select')||'') && u.searchParams.has('range');})()`), "Breakdown has no stable trigger-selection link to the map");
	});
	await run("allocation-forms", docFor("insights-budget-split"), async ({ t, evaluate }) => {
		await evaluate(`(() => {const original=window.fetch;window.__pdActionPosts=[];window.fetch=(url,opts)=>{if(String(url).startsWith('/api/act/')){window.__pdActionPosts.push({url:String(url),body:JSON.parse(opts.body)});const preview=String(url).endsWith('/preview');return Promise.resolve({ok:preview,status:preview?200:409,json:async()=>preview?{ticket:'browser-test-ticket',html:'<div class="confirm"><p>Browser test preview</p><span data-expires="300000">5:00</span><button type="button" data-confirm>Confirm</button><button type="button" data-cancel>Cancel</button></div>'}:{html:'<div class="confirm"><p>Browser test refusal, nothing changed</p><button type="button" data-close>Close</button></div>'}});}return original(url,opts);};})()`);
		for (const action of ["priorities-set", "envelope-set", "allocation-revert"]) {
			const selector = `form[data-action="${action}"]`;
			ensure(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `Missing structured ${action} form`);
			await evaluate(`(() => {const f=document.querySelector(${JSON.stringify(selector)});const details=f.closest('details');if(details)details.open=true;f.requestSubmit();})()`);
			await evaluate(paused, true);
			const posted = await evaluate(`window.__pdActionPosts.at(-1)`);
			ensure(posted?.url === `/api/act/${action}/preview`, `${action} did not send a preview`);
			if (action === "priorities-set") ensure(Array.isArray(posted.body.projects) && posted.body.projects.length > 0 && posted.body.projects.every((p) => Number.isInteger(p.weight)) && Number.isFinite(posted.body.validDays), "Priorities fields did not become typed project weights and a duration");
			if (action === "envelope-set") ensure(posted.body.envelope && typeof posted.body.envelope.floorsUsd === "object" && typeof posted.body.envelope.defaultWeights === "object" && typeof posted.body.envelope.enabled === "boolean", "Envelope fields did not become the typed envelope object");
			if (action === "allocation-revert") ensure(Number.isInteger(posted.body.index) && posted.body.index >= 0, "Revert did not preserve the machine history index");
			ensure(await evaluate(`!document.getElementById('confirm-slot').hidden && document.querySelector('#confirm-slot [data-expires]').textContent==='5:00'`), `${action} did not open its five-minute preview`);
			await click(t, evaluate, '#confirm-slot [data-confirm]');
			await evaluate(paused, true);
			ensure(await evaluate(`window.__pdActionPosts.at(-1).body.ticket==='browser-test-ticket' && Object.keys(window.__pdActionPosts.at(-1).body).length===1`), `${action} confirm sent editable fields instead of only its ticket`);
			await click(t, evaluate, '#confirm-slot [data-close]');
		}
	});
	// The normal width run already captures every role/theme at 375px. These matched extra captures prove the
	// phone card at 390px and the desktop card at 1440px, including selected/list and allocation controls.
	if (shots) for (const doc of docs.filter((d) => d.page.startsWith("insights") && !d.file.startsWith("panels/"))) for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
		let t;
		try {
			const page = await openPage({ browser, key: `spend-shot-${doc.id}-${width}-${theme}`, url: origin + doc.path, metrics: { width, height: 1000, deviceScaleFactor: 1, mobile: width < 760 }, emulated: theme, clockMs });
			t = page.t;
			const evaluate = page.evaluate;
			const metrics = await t.send("Page.getLayoutMetrics");
			const { data } = await t.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(metrics.cssContentSize.height), scale: 1 } });
			writeFileSync(join(shots, `${doc.id}.${width}.${theme}.png`), Buffer.from(data, "base64"));
			ensure(await evaluate(`document.scrollingElement.scrollWidth<=${width}`), `${doc.id} scrolls the page at ${width}px`);
		} catch (e) {
			results.push({ run: { key: `spend-shot-${doc.id}-${width}-${theme}`, doc, label: `${width}px ${theme}` }, failures: [e.message], notes: [] });
		} finally { if (t) await t.close().catch(() => {}); }
	}
	return results;
}
