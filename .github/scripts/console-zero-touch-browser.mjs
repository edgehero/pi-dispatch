/** Zero touch's rendered data, styles and native interactions under the console CSP (#770).
 * This fixture server does not execute writes. Endpoint guards, exact persistence and worker admission have
 * separate integration tests; here a canned refusal proves the browser sends the reviewed form schema. */
const ensure = (value, message) => { if (!value) throw new Error(message); };
const ROLES = ["operator", "viewer"];
const WIDTHS = [320, 390, 800, 1024, 1440];

/** The DOM read includes rendered text geometry, not only computed font size or element existence. */
export function zeroTouchMetrics() {
  const shown = (e) => {
    if (!e || !e.getClientRects().length || getComputedStyle(e).visibility === "hidden") return false;
    for (let parent = e.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS" && !parent.open && !parent.querySelector(":scope>summary")?.contains(e)) return false;
    return true;
  };
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const canvas = document.createElement("canvas").getContext("2d");
  const color = (value) => { canvas.fillStyle = "#ff00ff"; canvas.fillStyle = value.trim(); return canvas.fillStyle; };
  const token = (e, name) => color(getComputedStyle(e).getPropertyValue(`--${name}`));
  const sections = [...document.querySelectorAll('section[data-panel][id^="p-zt-"]')].filter(shown).map((e) => ({ id: e.id, ...box(e) }));
  const rate = document.querySelector("#p-zt-rate"), rateValue = rate?.querySelector(".kpi>b"), spark = rate?.querySelector(".zt-spark"), goal = spark?.querySelector(".zt-spark__goal");
  const project = document.querySelector("#p-zt-projects"), fixes = document.querySelector("#p-zt-fixes");
  const legends = [...document.querySelectorAll(".zt-whys>.zt-why:not(.zt-why--sum)")].filter(shown).map((e) => ({ word: e.querySelector("b")?.textContent, count: Number(e.querySelector(".zt-why__n")?.textContent), height: box(e)?.height, font: parseFloat(getComputedStyle(e.querySelector("b")).fontSize) }));
  const labels = [...document.querySelectorAll(".zt-cause-label")].filter(shown).map((e) => ({ value: e.textContent, ...box(e), font: parseFloat(getComputedStyle(e).fontSize), color: color(getComputedStyle(e).fill), expected: token(e, "on-tone") }));
  const bars = [...document.querySelectorAll(".zt-cause-svg")].filter(shown).map((e) => ({ label: e.getAttribute("aria-label"), height: box(e)?.height, rects: [...e.querySelectorAll(".zt-cause-rect")].map((r) => ({ color: color(getComputedStyle(r).fill), expected: token(r, "tone"), width: box(r)?.width })) }));
  const meters = [...document.querySelectorAll('[role="meter"]')].filter(shown).map((e) => ({ value: Number(e.getAttribute("aria-valuenow")), goal: e.querySelector(".zt-goal")?.getAttribute("x1"), bed: box(e.querySelector(".pbar__bed"))?.width, fill: box(e.querySelector(".pbar__fill"))?.width, label: e.getAttribute("aria-label") }));
  return {
    width: innerWidth, scrollWidth: document.scrollingElement.scrollWidth, fonts: document.fonts.status, font: getComputedStyle(document.body).fontFamily,
    css: [...document.styleSheets].some((s) => s.href?.endsWith("/static/console.css") && s.cssRules.length > 100), sections,
    rate: rateValue?.textContent, rateFont: rateValue ? parseFloat(getComputedStyle(rateValue).fontSize) : 0, rateColor: rateValue ? color(getComputedStyle(rateValue).color) : null, ink: token(document.body, "ink"), rateText: rate?.textContent,
    spark: spark ? { label: spark.getAttribute("aria-label"), height: box(spark)?.height, stroke: color(getComputedStyle(spark.querySelector(".zt-spark__l")).stroke), ink: token(spark, "ink"), goalColor: goal ? color(getComputedStyle(goal).stroke) : null, goalExpected: token(spark, "ok"), dashed: goal ? getComputedStyle(goal).strokeDasharray : "none" } : null,
    project: box(project), fixes: box(fixes), legends, labels, bars, meters,
    phoneProjects: shown(document.querySelector(".zt-phone-projects")), desktopProjects: shown(document.querySelector(".zt-desktop-projects")), phoneSummary: shown(document.querySelector(".zt-phone-summary")),
    groups: [...document.querySelectorAll(".zt-q,.ztp-q")].filter(shown).map((e) => ({ actions: [...e.querySelectorAll(".zt-q__act summary,.zt-q__act>a,.zt-q__act button,.ztp-q__a summary,.ztp-q__a>a,.ztp-q__a button")].filter(shown).length })),
    writeControls: [...document.querySelectorAll("form[data-action]")].length, questionsText: document.querySelector("#p-zt-questions")?.textContent,
    text: document.body.textContent, actions: [...document.querySelectorAll("form[data-action]")].map((f) => f.dataset.action),
  };
}

/** Pure verdicts have counterexample tests and a browser-side negative control. */
export function zeroTouchProblems(m, { width, role, readOnly = false } = {}) {
  const out = [], phone = width <= 760;
  if (!m.css || m.fonts !== "loaded" || !/system-ui|Segoe UI|Arial/.test(m.font)) out.push("Shared stylesheet or system fonts are missing");
  if (m.scrollWidth > width + 0.5) out.push("The complete page exceeds its viewport");
  if (m.rate !== "18%" || !m.rateText?.includes("38 of 214 runs") || m.rateFont < 30 || m.rateColor !== m.ink) out.push("The rate's value, denominator or primary hierarchy changed");
  if (!m.spark || !m.spark.label?.includes("31%, 30%, 28%, 24%, 23%, 21%, 19%, 18%") || m.spark.height < 55 || m.spark.stroke !== m.spark.ink || m.spark.goalColor !== m.spark.goalExpected || m.spark.dashed === "none") out.push("The rolling trend, its text equivalent or dashed goal is wrong");
  if (m.legends.length !== 6 || m.legends.map((r) => r.count).join() !== "17,5,7,5,3,1" || m.legends.some((r) => r.font < 12 || r.height < 24)) out.push("The six readable causes no longer reconcile with 38 touched runs");
  if (!m.labels.length || m.labels.some((r) => r.height < 9.5 || r.color !== r.expected)) out.push("Chart count labels are too small or use the wrong foreground");
  if (!m.bars.length || m.bars.some((b) => b.height < 24 || !b.label?.includes("full scale") || b.rects.some((r) => r.color !== r.expected))) out.push("Cause chart geometry, scale or palette changed");
  if (phone) {
    if (!m.phoneProjects || m.desktopProjects || !m.phoneSummary) out.push("The phone uses desktop rows instead of its compact read layout");
    const order = [...m.sections].sort((a, b) => a.top - b.top).map((r) => r.id);
    if (order.join() !== "p-zt-rate,p-zt-projects,p-zt-causes,p-zt-questions,p-zt-fixes") out.push("Phone sections are not in rate, projects, causes, questions, fixes order");
    if (role === "operator" && (m.groups.length !== 4 || m.groups.some((g) => g.actions > 1))) out.push("Phone question rows expose several competing actions");
    if (m.fixes && m.fixes.height > 180) out.push("The phone's fixes summary is expanded into the desktop section");
  } else {
    if (m.phoneProjects || !m.desktopProjects || m.phoneSummary) out.push("The desktop uses the phone replacement layout");
    if (!m.meters.length || m.meters.some((r) => r.goal !== "12.5%" || !r.label?.includes("goal under 5") || Math.abs(r.fill / r.bed - Math.min(1, r.value / 40)) > 0.02)) out.push("Project meters lost their 40-percent scale or 5-percent goal tick");
    if (width >= 1100 && role === "viewer" && m.project && m.fixes && Math.abs(m.project.left - m.fixes.left) > 2) out.push("The viewer's fixes are outside the wide project column");
  }
  if (!m.rateText?.includes("2 stopped before they ran") || !m.text?.includes("gh-2f6a") || !m.text?.includes("Median wait for an answer")) out.push("Stopped jobs, waiting run or wait median were lost");
  if (role === "viewer") {
    if (m.writeControls || /Test command|Rate limit scope|Package manager/.test(m.questionsText ?? "")) out.push("The viewer received question groups or write controls");
  } else if (readOnly && m.writeControls) out.push("The read-only console received write controls");
  if (!m.text?.includes("#772") || m.actions.some((a) => /draft|standing-answer|sandbox/.test(a))) out.push("Deferred answer or sandbox features are presented as active");
  return out;
}

export async function checkZeroTouchBrowser({ browser, docs, origin, openPage, clockMs }) {
  const results = [];
  const populated = (role) => docs.find((d) => d.file === `panels/zero-touch-populated.${role}.html`);
  const run = async (name, doc, check, { width = 1440, theme = "light", noScript = false } = {}) => {
    const result = { run: { key: `zero-touch-browser-${name}`, doc: doc ?? { path: name, page: "zero-touch", role: "operator" }, label: "Zero touch rendered behavior" }, failures: [], notes: [] };
    results.push(result); let target;
    try {
      ensure(doc, "The required Zero touch fixture is absent");
      const page = await openPage({ browser, key: name, url: origin + doc.path, metrics: { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 760 }, emulated: theme, clockMs, noScript });
      target = page.t; await page.evaluate("document.fonts.ready", true); await check(page);
      const errors = await page.evaluate("({csp:window.__pdCsp||[],errors:window.__pdErrors||[]})");
      ensure(!errors.csp.length && !errors.errors.length, JSON.stringify(errors));
    } catch (error) { result.failures.push(`${name}: ${error.message}`); }
    finally { if (target) await target.close().catch(() => {}); }
  };
  for (const role of ROLES) for (const width of WIDTHS) for (const theme of ["light", "dark"]) await run(`paint-${role}-${width}-${theme}`, populated(role), async ({ evaluate }) => {
    // Native open is deliberate: repository metrics are inside their project's disclosure, not elsewhere on the page.
    await evaluate("document.querySelectorAll('.zt-p').forEach(e=>e.open=true)");
    const m = await evaluate(`(${zeroTouchMetrics})()`), problems = zeroTouchProblems(m, { width, role });
    ensure(!problems.length, problems.join("; "));
  }, { width, theme });
  await run("readonly-keeps-reads", docs.find((d) => d.file === "panels/zero-touch-readonly.operator.html"), async ({ evaluate }) => {
    const m = await evaluate(`(${zeroTouchMetrics})()`);
    ensure(!m.writeControls && m.text.includes("38 of 214"), "Read-only lost reads or retained a write");
  }, { width: 800, theme: "dark" });
  for (const noScript of [false, true]) await run(`native-keyboard-${noScript ? "no-js" : "js"}`, populated("operator"), async ({ evaluate, t }) => {
    await evaluate("(()=>{const d=document.querySelector('.zt-p');d.open=false;d.querySelector('summary').focus();})()");
    await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    ensure(await evaluate("document.querySelector('.zt-p').open"), "Enter did not reveal the project's repository rows");
    const controls = await evaluate("(()=>{const links=[...document.querySelectorAll('a[href^=\"/runs/zero-touch?days=\"]')],f=document.querySelector('form[data-action]');return{windows:links.map(a=>a.getAttribute('href')),disabled:f&&[...f.querySelectorAll('button')].every(b=>b.matches(':disabled')),text:document.body.textContent}})()");
    ensure([7, 30, 90].every((n) => controls.windows.some((href) => href === `/runs/zero-touch?days=${n}`)), "Window links do not preserve the closed 7/30/90-day read schema");
    if (noScript) ensure(controls.disabled && controls.text.includes("Reading and navigation work without it."), "No-script writes can submit or their explanation is missing");
  }, { width: 1024, noScript });
  await run("keyboard-name-preview-refusal", populated("operator"), async ({ evaluate, t }) => {
    await evaluate(`(()=>{window.__ztPosts=[];const old=window.fetch;window.fetch=(url,init)=>{if(String(url).startsWith('/api/act/')){window.__ztPosts.push({url:String(url),headers:init.headers,body:JSON.parse(init.body)});return Promise.resolve({ok:false,status:409,json:async()=>({error:'The grouping configuration changed. Preview it again.'})});}return old(url,init);};const f=[...document.querySelectorAll('form[data-action="zero-touch-name"]')].find(e=>e.closest('details').querySelector('summary').getClientRects().length);window.__ztNameForm=f;const editor=f.closest('details');editor.open=true;f.querySelector('[name=name]').value='Human browser group';f.querySelector('button').focus();})()`);
    await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await evaluate("new Promise(r=>setTimeout(r,50))", true);
    const got = await evaluate("({posts:window.__ztPosts,value:window.__ztNameForm.querySelector('[name=name]').value,href:location.href,error:window.__ztNameForm.querySelector('[data-form-error]').textContent})");
    ensure(got.posts.length === 1 && got.posts[0].url === "/api/act/zero-touch-name/preview" && got.posts[0].body.name === "Human browser group" && /^[a-f0-9]{32}$/.test(got.posts[0].body.groupId) && Object.keys(got.posts[0].headers).some((key) => key.toLowerCase() === "x-console-as"), "Keyboard preview lost its exact schema or person binding");
    ensure(got.value === "Human browser group" && !got.href.includes("Human") && got.error.includes("configuration changed"), "A refused preview lost input or exposed it in navigation");
  }, { width: 390, theme: "dark" });
  await run("native-phone-observations-no-js", populated("operator"), async ({ evaluate, t }) => {
    await evaluate("document.querySelector('.zt-phone-fixes>summary').focus()");
    await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    ensure(await evaluate("(()=>{const d=document.querySelector('.zt-phone-fixes'),s=d.querySelector('summary'),style=getComputedStyle(s);return d.open&&d.querySelectorAll('.zt-fx').length===2&&d.querySelector('.zt-ba').getBoundingClientRect().height>0&&style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>=2;})()"), "Phone observations are unavailable without JavaScript or keyboard focus is invisible");
  }, { width: 390, noScript: true });
  await run("instruction-and-paid-group-preview-schemas", populated("operator"), async ({ evaluate }) => {
    await evaluate(`(()=>{window.__ztPosts=[];const old=window.fetch;window.fetch=(url,init)=>{if(String(url).startsWith('/api/act/')){window.__ztPosts.push({url:String(url),headers:init.headers,body:JSON.parse(init.body)});return Promise.resolve({ok:false,status:409,json:async()=>({error:'The source changed. Reload and preview it again.'})});}return old(url,init);};const f=document.querySelector('form[data-action="zero-touch-instruction"]');f.closest('details').open=true;f.querySelector('[name=sentence]').value='Use the reviewed test command.';f.requestSubmit();})()`);
    await evaluate("new Promise(r=>setTimeout(r,30))", true);
    await evaluate("document.querySelector('form[data-action=\"zero-touch-group\"]').requestSubmit()");
    await evaluate("new Promise(r=>setTimeout(r,30))", true);
    const posts = await evaluate("window.__ztPosts");
    ensure(posts.length === 2 && posts[0].url === "/api/act/zero-touch-instruction/preview" && Object.keys(posts[0].body).sort().join() === "groupId,index,runId,sentence" && posts[0].body.index === 2 && posts[0].body.sentence === "Use the reviewed test command.", "Instruction preview dropped source identity, integer trigger index or exact sentence");
    ensure(posts[1].url === "/api/act/zero-touch-group/preview" && Object.keys(posts[1].body).join() === "runId" && posts[1].body.runId === "gh-ungrouped" && posts.every((p) => Object.keys(p.headers).some((key) => key.toLowerCase() === "x-console-as")), "Paid grouping did not use its reference-only, person-bound preview schema");
    ensure(await evaluate("!location.href.includes('reviewed')&&document.querySelector('[name=sentence]').value==='Use the reviewed test command.'"), "Refused instruction preview lost input or placed it in URL history");
  });
  await run("exceptional-grouping-controls", docs.find((d) => d.file === "panels/zero-touch-grouping-errors.operator.html"), async ({ evaluate }) => {
    const states = await evaluate("[...document.querySelectorAll('[data-group-status]')].map(e=>({status:e.dataset.groupStatus,button:!!e.querySelector('form[data-action]'),text:e.textContent}))");
    ensure(states.length === 8 && states.every((s) => s.text.length > 25), "A grouping failure has no actionable explanation");
    ensure(states.filter((s) => !["stale", "refused", "failed"].includes(s.status)).every((s) => !s.button), "An expired, missing or overlong source offers a paid job that cannot work");
  }, { width: 390, theme: "dark" });
  await run("chart-negative-control", populated("operator"), async ({ evaluate }) => {
    await evaluate("document.querySelectorAll('.zt-cause-label').forEach(e=>e.style.fontSize='2px')");
    const problems = zeroTouchProblems(await evaluate(`(${zeroTouchMetrics})()`), { width: 1440, role: "operator" });
    ensure(problems.includes("Chart count labels are too small or use the wrong foreground"), "The chart negative control was not detected");
  });
  return results;
}
