/** Configuration's real DOM interactions under the production CSP (#750). HTTP answers are canned;
 * the actual action planners and persistence are verified separately by the action tests. */
const ensure = (ok, why) => {
  if (!ok) throw new Error(why);
};
export async function checkConfigBrowser({
  browser,
  docs,
  origin,
  openPage,
  clockMs,
}) {
  const results = [];
  const run = async (
    name,
    pageName,
    check,
    { width = 1440, theme = "light", noScript = false, docOverride = null } = {},
  ) => {
    const doc = docOverride ?? docs.find(
      (d) =>
        d.page === pageName &&
        d.role === "operator" &&
        !d.file.startsWith("panels/"),
    );
    const result = {
      run: {
        key: `config-browser-${name}`,
        doc: doc ?? { id: name, path: name, page: pageName, role: "operator" },
        label: "configuration browser behavior",
      },
      failures: [],
      notes: [],
    };
    results.push(result);
    let target;
    try {
      ensure(doc, `${pageName} fixture absent`);
      const page = await openPage({
        browser,
        key: name,
        url: origin + doc.path,
        metrics: {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: width < 760,
        },
        emulated: theme,
        clockMs,
        noScript,
      });
      target = page.t;
      await check(page);
      const errors = await page.evaluate(
        `({csp:window.__pdCsp||[],errors:window.__pdErrors||[]})`,
      );
      ensure(
        !errors.csp.length && !errors.errors.length,
        JSON.stringify(errors),
      );
    } catch (e) {
      result.failures.push(`${name}: ${e.message}`);
    } finally {
      if (target) await target.close().catch(() => {});
    }
  };
  for (const pageName of ["config", "trigger", "trigger-add"]) for (const width of [390, 800, 1440])
    for (const theme of ["light", "dark"])
      await run(
        `paint-${pageName}-${width}-${theme}`,
        pageName,
        async ({ evaluate }) => {
          ensure(
            await evaluate(
              `(()=>{const card=document.querySelector('.card'),select=document.querySelector('.config-form select');return card&&(${width}>1100||card.getBoundingClientRect().width>=${width}*.8)&&[...document.querySelectorAll('.facts dd')].every(e=>e.getBoundingClientRect().width>=60)&&parseFloat(getComputedStyle(card).borderRadius)>=10&&select&&getComputedStyle(select).fontFamily!=='Times New Roman'&&document.scrollingElement.scrollWidth<=${width};})()`,
            ),
            "Pulse configuration styling or responsive layout is absent",
          );
        },
        { width, theme },
      );
  await run("no-webhook-blocks-submit", "trigger-add", async ({evaluate}) => {
    ensure(await evaluate(`(()=>{const f=document.querySelector('form[data-structured="trigger"]');f.querySelector('[name="flow"]').value='triage';const forge=f.querySelector('[data-trigger-kind="label"] [name="forge"]');let submits=0;f.addEventListener('submit',()=>submits++);f.requestSubmit();return forge.options.length===0&&forge.validity.valueMissing&&submits===0;})()`), "An absent webhook still permits an implicit default forge submission");
  }, {docOverride:docs.find(d=>d.file.endsWith("trigger-editor-no-webhook.operator.html"))});
  await run("kind-forge-and-preview", "trigger-add", async ({ evaluate }) => {
    await evaluate(
      `(()=>{const original=window.fetch;window.__configPosts=[];window.fetch=(url,opts)=>{if(String(url).startsWith('/api/act/')){window.__configPosts.push({url:String(url),body:JSON.parse(opts.body)});return Promise.resolve({ok:false,status:400,json:async()=>({refusal:'flow must name an available skill. Nothing was changed.'})});}return original(url,opts);};})()`,
    );
    for (const kind of ["cron", "label", "comment", "pull_request", "issue"]) {
      const answer = await evaluate(
        `(()=>{const f=document.querySelector('form[data-structured="trigger"]'),set=(n,v)=>{const es=[...f.elements].filter(e=>e.name===n&&!e.disabled&&!e.closest('fieldset[disabled]'));if(es[0])es[0].value=v;};set('kind',${JSON.stringify(kind)});f.querySelector('[name="kind"]').dispatchEvent(new Event('change',{bubbles:true}));set('flow','triage');set('id','nightly');set('pattern','0 3 * * *');set('folder','/allowed/repo');set('task','Review');set('phrase','@pi');set('labels','pi');set('number','42');set('once','false');f.requestSubmit();return [...f.querySelectorAll('[data-trigger-kind]')].filter(e=>!e.hidden).map(e=>e.dataset.triggerKind);})()`,
      );
      ensure(
        answer.length === 1 && answer[0] === kind,
        `${kind}: unrelated kind fields remain visible`,
      );
      await evaluate(`new Promise(r=>setTimeout(r,60))`, true);
      const posted = await evaluate(`window.__configPosts.at(-1)`);
      ensure(
        posted?.url === "/api/act/trigger-add/preview" &&
          posted.body.trigger?.kind === kind,
        `${kind}: fields were not packed as the add contract`,
      );
      ensure(
        typeof posted.body.trigger.maxTurns !== "string",
        `${kind}: maxTurns lost its numeric type`,
      );
      if (kind !== "cron")
        ensure(
          !("folder" in posted.body.trigger) &&
            !("task" in posted.body.trigger),
          `${kind}: disabled cron fields leaked into add`,
        );
      else
        ensure(
          !("statusComment" in posted.body.trigger) &&
            !("recover" in posted.body.trigger),
          "cron sent unsupported flags",
        );
    }
    ensure(
      await evaluate(
        `(()=>{const f=document.querySelector('form[data-structured="trigger"]'),c=f.querySelector('[name="flow"]');return c.getAttribute('aria-invalid')==='true'&&!!document.getElementById(c.getAttribute('aria-describedby'))&&document.activeElement===c;})()`,
      ),
      "Refusal was not associated with and focused on its field",
    );
  });
  await run(
    "facts-without-javascript",
    "config",
    async ({ evaluate }) => {
      ensure(
        await evaluate(
          `!!document.querySelector('#cf-settings select')&&!!document.querySelector('#cf-triggers a[href^="/config/trigger?"]')&&document.querySelector('[data-theme-toggle]').hidden&&[...document.querySelectorAll('.config-form button[type=submit]')].every(b=>b.matches(':disabled'))`,
        ),
        "Configuration facts/navigation do not survive without scripts",
      );
    },
    { noScript: true },
  );
  return results;
}
