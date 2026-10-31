/** #766/#772: actual application routes, live Valkey, real preview/confirm and CSP; no model or worker starts. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openChrome } from "../../launch/chrome-pipe.mjs";
import { findChrome, chromeLaunchArgs } from "./console-width-check.mjs";
import { startAnswererBrowserFixture, ANSWERER_BROWSER_TOKENS } from "../../admin/test/helpers/answerer-browser.mjs";
import { SECURITY_HEADERS } from "../../admin/src/console/headers.mjs";

export async function checkAnswererBrowser({ chrome, shots = null, sandbox = process.env.GITHUB_ACTIONS !== "true" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "pd-answerer-browser-")), children = new Set();
  let fixture, browser, tab, stage = "startup";
  try {
    mkdirSync(join(work, "app")); fixture = await startAnswererBrowserFixture(join(work, "app"));
    mkdirSync(join(work, "browser"));
    browser = await openChrome({ chrome, work: join(work, "browser"), children, env: { HOME: process.env.HOME }, extraArgs: chromeLaunchArgs({ sandbox }), resolverRules: "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", captureStderr: true });
    const product = (await browser.send("Browser.getVersion")).product;
    assert.equal(product.split("/")[1], JSON.parse(readFileSync(new URL("../chrome-for-testing.json", import.meta.url))).version, "Use the verified pinned Chrome for Testing artifact");
    tab = await browser.openTarget();
    await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__answererCsp=[];addEventListener('securitypolicyviolation',e=>window.__answererCsp.push(e.violatedDirective+':'+e.blockedURI));" });
    const evaluate = async expression => {
      const result = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async expression => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        try { if (await evaluate(`Boolean(${expression})`)) return; } catch (error) { if (!/context|navigat/.test(error.message)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };
    const navigate = async path => {
      const loaded = browser.event(m => m.sessionId === tab.sessionId && m.method === "Page.loadEventFired", "answerer page load");
      const response = browser.event(m => m.sessionId === tab.sessionId && m.method === "Network.responseReceived" && m.params.type === "Document" && m.params.response.url.startsWith(fixture.origin + "/"), "answerer document response");
      loaded.catch(() => {}); response.catch(() => {});
      await tab.send("Page.navigate", { url: fixture.origin + path }); await loaded;
      const headers = Object.fromEntries(Object.entries((await response).params.response.headers).map(([name, value]) => [name.toLowerCase(), value]));
      assert.equal(headers["content-security-policy"], SECURITY_HEADERS["content-security-policy"]);
      await until("document.readyState==='complete'");
      await evaluate("document.fonts.ready.then(()=>true)");
    };
    const click = async selector => {
      const rect = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!document.elementFromPoint(x,y)?.closest(${JSON.stringify(selector)}))throw Error('obscured click target');return{x,y};})()`);
      for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, ...rect, button: "left", clickCount: 1 });
    };
    const type = async (selector, text) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();})()`); await tab.send("Input.insertText", { text }); };
    const login = async role => {
      await tab.send("Network.clearBrowserCookies"); await navigate("/login");
      await until("document.querySelector('#login-form')&&!document.querySelector('#login-form').hidden");
      await type("#token", ANSWERER_BROWSER_TOKENS[role]); await click("#login-form button");
      await until("location.pathname==='/'");
    };
    const capture = async name => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true }); await evaluate("window.scrollTo(0,0)");
      const metrics = await tab.send("Page.getLayoutMetrics"), rect = metrics.cssContentSize ?? metrics.contentSize;
      const result = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: rect.width, height: rect.height, scale: 1 } }, 60000);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(result.data, "base64"));
    };
    const checkPaint = async ({ role, width, theme }) => {
      const result = await evaluate(`(()=>{const style=getComputedStyle(document.body),visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';return{width:document.scrollingElement.scrollWidth,canvas:style.getPropertyValue('--canvas').trim(),fonts:document.fonts.status,font:style.fontFamily,css:[...document.styleSheets].some(s=>s.href?.endsWith('/static/console.css')&&s.cssRules.length>100),heads:[...document.querySelectorAll('h2')].map(e=>e.textContent),probs:[...document.querySelectorAll('.wb-p__b')].filter(visible).map(e=>({label:e.getAttribute('aria-label'),height:e.getBoundingClientRect().height,fill:getComputedStyle(e.querySelector('.wb-p__fill')).fill,ratio:e.querySelector('.wb-p__fill').getBoundingClientRect().width/e.getBoundingClientRect().width,selected:e.closest('li').classList.contains('wb-p--on')})),actions:[...document.querySelectorAll('form[data-action]')].map(e=>e.dataset.action),text:document.body.textContent,csp:window.__answererCsp};})()`);
      assert.ok(result.width <= width + 1, `${role} ${theme} ${width}: overflow to ${result.width}`);
      assert.equal(result.canvas, theme === "light" ? "#edeeec" : "#000000");
      assert.equal(result.fonts, "loaded"); assert.match(result.font, /system-ui|Arial|Segoe UI/); assert.equal(result.css, true); assert.deepEqual(result.csp, []);
      assert.ok(!result.text.includes(fixture.model.privateDraft.question) && !result.text.includes(fixture.model.privateDraft.draft), "The inbox never holds question/draft bytes");
      if (role !== "operator") {
        for (const forbidden of ["CONTRIBUTING", "convention", "confidence", "example/drafter", "category-disallowed"]) assert.ok(!result.text.includes(forbidden), `${role} received ${forbidden}`);
        assert.equal(result.actions.length, 0);
        assert.ok(await evaluate("document.querySelector('.pav-grid').getBoundingClientRect().width/document.querySelector('#p-questions').getBoundingClientRect().width>=0.99"), "Read-only role cards fill the no-sidebar content width");
      } else {
        if (width <= 760) assert.ok(await evaluate("[...document.querySelectorAll('.pap-jev')].some(e=>e.getClientRects().length&&e.textContent.includes('0.86')&&e.textContent.includes('0.91'))"));
        else {
          const expected = [...Object.entries(fixture.model.rows[0].probabilities).map(([name, p]) => [`category: ${name}, ${p.toFixed(2)}`, p]), ["answerable_from_sources: yes, 0.91", 0.91], ["answerable_from_sources: no, 0.09", 0.09]];
          assert.deepEqual(result.probs.map(p => p.label), expected.map(([label]) => label), "Every recorded category and binary option has its visible label");
          result.probs.forEach((p, index) => { assert.ok(p.height >= 8); assert.ok(Math.abs(p.ratio - expected[index][1]) < 0.001, "A bar's actual rendered length matches its recorded probability"); });
          assert.deepEqual(result.probs.filter(p => p.selected).map(p => p.label), ["category: convention, 0.86", "answerable_from_sources: yes, 0.91"]);
          assert.notEqual(result.probs[0].fill, result.probs[1].fill, "Selected and remaining choices keep their reference palette");
        }
        for (const section of ["Answer rule:", "How much it may do", "Standing answers"]) assert.ok(result.heads.some(head => head.includes(section)), section);
        if (width <= 760) {
          assert.equal(await evaluate("[...document.querySelectorAll('.pa-desktop-actions a')].filter(e=>e.getClientRects().length).length"), 0);
          assert.ok(await evaluate("[...document.querySelectorAll('.pa-q .qform__act')].every(e=>e.querySelector('.btn--answer').getBoundingClientRect().width/e.getBoundingClientRect().width>=0.99)"), "The phone's sole manual action fills its row, as the reference does");
        }
      }
      return result;
    };
    const widths = [320, 375, 390, 760, 761, 800, 1024, 1440];
    const paints = [];
    for (const role of ["operator", "viewer", "agent"]) {
      await login(role);
      for (const theme of ["light", "dark"]) for (const width of widths) {
        stage = `paint ${role} ${theme} ${width}`;
        await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await navigate("/parked"); paints.push(await checkPaint({ role, width, theme }));
        if ([390, 800, 1440].includes(width)) await capture(`answerer-${role}-${theme}-${width}`);
      }
      if (role !== "operator") {
        stage = `${role} private run and rule routes`;
        await navigate(`/run?id=${encodeURIComponent(fixture.sourceRunId)}`);
        assert.ok(await evaluate(`![${JSON.stringify(fixture.model.privateDraft.question)},${JSON.stringify(fixture.model.privateDraft.draft)},'CONTRIBUTING','0.86','example/drafter'].some(x=>document.body.textContent.includes(x))`));
        assert.equal(await evaluate("document.querySelectorAll('form[data-action]').length"), 0);
        await navigate("/parked/rules"); assert.ok(!await evaluate("document.body.textContent.includes('known-conventions')"));
        stage = `${role} direct person-action refusal`;
        const refused = await evaluate(`fetch('/api/act/standing-answer-add/preview',{method:'POST',headers:{'content-type':'application/json','x-console-as':${JSON.stringify(`${role}.${role}`)}},body:JSON.stringify({title:'Synthetic',text:'Synthetic standing answer',projects:['web'],repo:'github:acme/web'})}).then(async r=>({status:r.status,body:await r.json()}))`);
        assert.equal(refused.status, 403); assert.ok(!JSON.stringify(refused.body).includes("Synthetic standing answer"));
      }
    }
    stage = "an agent previews and applies a real narrowing write but cannot take its wider inverse";
    const api = (action, phase, body, actor) => evaluate(`fetch('/api/act/'+${JSON.stringify(action)}+'/'+${JSON.stringify(phase)},{method:'POST',headers:{'content-type':'application/json','x-console-as':${JSON.stringify(actor)}},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>({status:r.status,body:await r.json()}))`);
    const pausePreview = await api("fleet-pause", "preview", {}, "agent.agent");
    assert.equal(pausePreview.status, 200); assert.equal(pausePreview.body.agent.mode, "unattended");
    assert.equal(await fixture.queue.isPaused(), false, "An agent preview leaves the real queue running");
    const pauseApplied = await api("fleet-pause", "confirm", { ticket: pausePreview.body.ticket }, "agent.agent");
    assert.equal(pauseApplied.status, 200); assert.equal(await fixture.queue.isPaused(), true);
    assert.equal((await fixture.agentWrites()).count, 1, "The local audit counts the actual agent applied receipt");
    assert.equal((await api("fleet-pause", "confirm", { ticket: pausePreview.body.ticket }, "agent.agent")).status, 409, "A browser cannot replay a used agent ticket");
    assert.equal((await api("fleet-resume", "preview", {}, "agent.agent")).status, 403, "The current inverse policy requires a person");
    await login("operator");
    const resumePreview = await api("fleet-resume", "preview", {}, "ops.operator");
    assert.equal(resumePreview.status, 200); assert.equal(resumePreview.body.agent.mode, "confirm");
    assert.equal((await api("fleet-resume", "confirm", { ticket: resumePreview.body.ticket }, "ops.operator")).status, 200);
    assert.equal(await fixture.queue.isPaused(), false);
    stage = "shared styling negative control"; await navigate("/parked");
    await evaluate("document.querySelector('link[href=\"/static/console.css\"]').disabled=true");
    await assert.rejects(checkPaint({ role: "operator", width: 1440, theme: "dark" }), /AssertionError|Expected|overflow/);
    stage = "production CSP negative control"; await navigate("/parked");
    await evaluate("window.__inlineRan=false;const probe=document.createElement('script');probe.textContent='window.__inlineRan=true';document.head.appendChild(probe)");
    await until("window.__answererCsp.some(x=>x.startsWith('script-src')&&x.endsWith(':inline'))");
    assert.equal(await evaluate("window.__inlineRan"), false);
    stage = "full-page run, rule, count and filtered-audit evidence";
    for (const theme of ["light", "dark"]) for (const width of [390, 1440]) {
      await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 });
      await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      for (const [name, path] of [["answerer-run-draft", `/run?id=${encodeURIComponent(fixture.sourceRunId)}`], ["answerer-helper-run", `/run?id=${encodeURIComponent(fixture.model.rows[0].draftRunId === "gh-a07c" ? "answer-draft-browser-0" : fixture.model.rows[0].draftRunId)}`], ["answerer-rules", "/parked/rules"], ["agent-writes-overview", "/"], ["agent-writes-audit", "/audit?role=agent&action=write-applied"]]) {
        await navigate(path);
        if (name === "answerer-helper-run") {
          assert.ok(await evaluate(`document.body.textContent.includes(${JSON.stringify(fixture.model.privateDraft.question)})&&document.body.textContent.includes(${JSON.stringify(fixture.model.privateDraft.draft)})`));
          assert.equal(await evaluate("document.querySelectorAll('form[data-action=\"parked-answer\"]').length"), 0, "The helper never offers to send a reply");
        }
        assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=${width}+1`), `${name} ${theme} ${width}: complete page fits its viewport`);
        await capture(`${name}-${theme}-${width}`);
      }
    }
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    stage = "live edited answer and separate standing adoption";
    await navigate(`/run?id=${encodeURIComponent(fixture.sourceRunId)}`);
    await until("document.querySelector('#run-answer')");
    assert.equal(await evaluate("document.querySelector('#run-answer').value"), fixture.model.privateDraft.draft);
    stage = "a checkbox alone holds a live panel even after focus leaves";
    await click("[data-keep-standing]"); await click("h1"); await fixture.refresh(61000);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate("document.querySelector('[data-keep-standing]').checked"), true, "The checkbox alone is dirty even when its string value is unchanged");
    const edited = "Use the reviewed npm test command. <script>synthetic text</script>";
    await type("#run-answer", edited);
    await fixture.refresh(); await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await evaluate("({text:document.querySelector('#run-answer').value,keep:document.querySelector('[data-keep-standing]').checked})"), { text: edited, keep: true });
    const countBefore = await fixture.queue.getJobCountByTypes("waiting");
    await evaluate("document.querySelector('form[data-action=\"parked-answer\"] button[type=\"submit\"]').focus()");
    for (const type of ["keyDown", "keyUp"]) await tab.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
    await until("document.querySelector('[data-confirm]')&&!document.querySelector('[data-confirm]').disabled");
    assert.equal(await fixture.queue.getJobCountByTypes("waiting"), countBefore, "Preview sends no reply");
    assert.ok(await evaluate("document.querySelector('#confirm-slot').textContent.includes('Use the reviewed npm test command.')"));
    await fixture.refresh(); await click("[data-cancel]");
    assert.equal(await evaluate("document.querySelector('#run-answer').value"), edited, "Cancel preserves the person's edit");
    await click('form[data-action="parked-answer"] button[type="submit"]');
    await until("document.querySelector('[data-confirm]')&&!document.querySelector('[data-confirm]').disabled"); await click("[data-confirm]");
    try { await until("document.querySelector('[data-standing-adoption]').open&&document.activeElement?.name==='title'"); }
    catch (error) {
      await capture("answerer-send-adoption-failure");
      const problem = await evaluate("({path:location.pathname,adoptionOpen:document.querySelector('[data-standing-adoption]')?.open,active:document.activeElement?.name,slotTitle:document.querySelector('[data-slot-title]')?.textContent,slotMessage:document.querySelector('[data-slot-message]')?.textContent,slotRefusal:document.querySelector('#confirm-slot .confirm__refusal')?.textContent,fieldsetDisabled:document.querySelector('[data-standing-adoption] fieldset')?.disabled})");
      throw new Error(error.message + ': ' + JSON.stringify(problem));
    }
    const queued = await fixture.queue.getJobs(["waiting"], 0, -1);
    const reply = queued.find(job => job.data.console?.draftSourceRunId === fixture.sourceRunId);
    assert.ok(reply, "The actual confirm queued a reply with its validated provenance");
    assert.equal(reply.data.console.by, "ops"); assert.equal(reply.data.trigger.comment.body, edited);
    assert.equal(fixture.document().standingAnswers.length, 1, "Ticking adoption did not save standing policy");
    await type('[data-standing-adoption] [name="title"]', "Reviewed browser answer");
    await click('[data-standing-adoption] button[type="submit"]'); await until("document.querySelector('[data-confirm]')&&!document.querySelector('[data-confirm]').disabled");
    assert.equal(fixture.document().standingAnswers.length, 1);
    await capture("standing-answer-preview"); await click("[data-confirm]");
    await until("document.readyState==='complete'&&!document.querySelector('[data-standing-adoption][open]')");
    assert.equal(fixture.document().standingAnswers.length, 2); assert.equal(fixture.document().standingAnswers[1].text, edited);
    stage = "no JavaScript rules and native controls";
    await tab.send("Emulation.setScriptExecutionDisabled", { value: true }); await navigate("/parked/rules");
    assert.equal(await evaluate("[...document.querySelectorAll('[data-answerer-control]')].every(e=>e.disabled)"), true);
    assert.ok(await evaluate("document.body.textContent.includes('Reading and navigation work without JavaScript')")); await capture("answerer-rules-no-javascript");
    await navigate(`/run?id=${encodeURIComponent(fixture.sourceRunId)}`);
    assert.equal(await evaluate("document.querySelector('form[data-action=\"parked-answer\"] fieldset').disabled"), true, "No-script answers cannot submit text through a fallback GET");
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
    stage = "final receipt and metadata checks";
    const state = await fixture.store.readMeta(fixture.sourceRunId);
    assert.equal(state.status, "sent"); assert.equal(state.disposition, "edited");
    assert.equal(await fixture.store.privateDraft(fixture.sourceRunId), null);
    assert.ok(!fixture.logs.some(line => line.includes(edited)));
    await fixture.close(); fixture = null;
    mkdirSync(join(work, "drop-app")); fixture = await startAnswererBrowserFixture(join(work, "drop-app"));
    await login("operator");
    stage = "no JavaScript also disables dropping a retained draft";
    await tab.send("Emulation.setScriptExecutionDisabled", { value: true }); await navigate(`/run?id=${encodeURIComponent(fixture.sourceRunId)}`);
    assert.equal(await evaluate(`document.querySelector('form[data-action="answer-draft-drop"]').closest('fieldset').disabled`), true);
    await tab.send("Emulation.setScriptExecutionDisabled", { value: false });
    stage = "stale drop confirmation refuses before changing the retained draft";
    await navigate(`/run?id=${encodeURIComponent(fixture.sourceRunId)}`);
    await click('form[data-action="answer-draft-drop"] button[type="submit"]');
    await until("document.querySelector('[data-confirm]')&&!document.querySelector('[data-confirm]').disabled");
    const originalDocument = fixture.document();
    fixture.saveDocument({ ...originalDocument, answerRules: originalDocument.answerRules.map(rule => ({ ...rule, categories: ["how-to"] })) });
    await fixture.refresh();
    await click("[data-confirm]");
    await until("document.querySelector('#confirm-slot').textContent.includes('changed')");
    assert.equal((await fixture.store.readMeta(fixture.sourceRunId)).status, "drafted");
    await navigate(`/run?id=${encodeURIComponent(fixture.sourceRunId)}`);
    assert.equal((await fixture.service.read({ role: "operator", runId: fixture.sourceRunId })).privateDraftProblem, "config-changed");
    await until("document.body.textContent.includes('This draft cannot be offered')");
    assert.equal(await evaluate("document.querySelector('#run-answer').value"), "");
    await capture("answerer-stale-rule");
    fixture.saveDocument(originalDocument);
    await fixture.refresh();
    stage = "dropping the exact retained draft leaves the parked question and queue unchanged";
    await navigate(`/run?id=${encodeURIComponent(fixture.sourceRunId)}`);
    const dropCount = await fixture.queue.getJobCountByTypes("waiting");
    await click('form[data-action="answer-draft-drop"] button[type="submit"]');
    await until("document.querySelector('[data-confirm]')&&!document.querySelector('[data-confirm]').disabled");
    await click("[data-confirm]");
    const dropEnd = Date.now() + 5000;
    while ((await fixture.store.readMeta(fixture.sourceRunId))?.status !== "dropped" && Date.now() < dropEnd) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await fixture.store.readMeta(fixture.sourceRunId)).status, "dropped", "The actual confirmation dropped the retained body");
    await fixture.refresh(16000);
    await until("document.readyState==='complete'&&document.querySelector('#run-answer')&&!document.querySelector('[name=draftRunId]')");
    assert.equal((await fixture.store.readMeta(fixture.sourceRunId)).status, "dropped");
    assert.equal(await fixture.store.privateDraft(fixture.sourceRunId), null);
    assert.equal(await fixture.queue.getJobCountByTypes("waiting"), dropCount);
    await capture("answerer-dropped");
    stage = "unavailable answerer evidence remains an explicit failure";
    fixture.state.unavailable = true; await navigate("/parked");
    assert.ok(await evaluate("document.body.textContent.includes('Answer-rule results could not be read')"));
    await capture("answerer-unavailable"); fixture.state.unavailable = false;
    await fixture.close(); fixture = null;
    mkdirSync(join(work, "readonly-app")); fixture = await startAnswererBrowserFixture(join(work, "readonly-app"), { readOnly: true });
    await login("operator"); stage = "read-only keeps facts and refuses all writes"; await navigate("/parked");
    assert.ok(await evaluate("document.body.textContent.includes('docs/CONTRIBUTING.md')"));
    assert.equal(await evaluate("document.querySelectorAll('form[data-action]').length"), 0);
    await capture("answerer-readonly");
    return { paints: paints.length, interactions: "real confirmed reply, edited provenance, separate standing adoption, live draft preservation, person-role refusals and native no-script reads" };
  } catch (error) { error.stack = `Answerer browser (${stage}): ${error.stack}`; throw error; }
  finally {
    if (tab) await tab.close().catch(() => {});
    if (browser) { await browser.close(); browser.removeSingleton(); }
    for (const child of children) child.kill("SIGKILL");
    await fixture?.close(); rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = findChrome(); const chrome = typeof found === "string" ? found : found?.path;
  const shotsAt = process.argv.indexOf("--shots");
  checkAnswererBrowser({ chrome, shots: shotsAt >= 0 ? process.argv[shotsAt + 1] : null }).then(result => console.log(JSON.stringify(result)), error => { console.error(error.stack); process.exitCode = 1; });
}
