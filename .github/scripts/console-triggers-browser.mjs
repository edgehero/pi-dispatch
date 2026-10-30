/** Trigger discovery and the read-only hypothetical checker under the real console CSP (#750).
 * Requests are intercepted in-page; endpoint authorization and receiver matching have separate integration tests. */
const ensure = (value, message) => { if (!value) throw new Error(message); };
export async function checkTriggersBrowser({ browser, docs, origin, openPage, clockMs }) {
  const results = [];
  async function run(name, pageName, role, check, { width = 1440, theme = "light", noScript = false, docOverride = null } = {}) {
    const doc = docOverride ?? docs.find((d) => d.page === pageName && d.role === role && d.file === `${pageName}.${role}.html`);
    const result = { run: { key: `triggers-browser-${name}`, doc: doc ?? { id:name,path:name,page:pageName,role }, label:"trigger discovery and hypothetical checker" }, failures:[],notes:[] };
    results.push(result);
    let target;
    try {
      ensure(doc, `${pageName} ${role} fixture absent`);
      const page = await openPage({ browser, key:name, url:origin+doc.path, metrics:{width,height:1000,deviceScaleFactor:1,mobile:width<760},emulated:theme,clockMs,noScript });
      target=page.t;
      await check(page);
      const errors=await page.evaluate(`({csp:window.__pdCsp||[],errors:window.__pdErrors||[]})`);
      ensure(!errors.csp.length&&!errors.errors.length,JSON.stringify(errors));
    } catch (e) { result.failures.push(`${name}: ${e.message}`); }
    finally { if(target) await target.close().catch(()=>{}); }
  }
  for(const role of ["operator","viewer"]) for(const width of [390,800,1440]) for(const theme of ["light","dark"])
    await run(`layout-${role}-${width}-${theme}`,"triggers",role,async({evaluate})=>{
      const paint = await evaluate(`(()=>{
        const problems=[],f=document.querySelector('form[data-trigger-check]'),r=document.querySelector('[data-trigger-check-result]'),card=document.querySelector('.card');
        const visible=e=>!!e&&e.getClientRects().length>0;
        const ctx=document.createElement('canvas').getContext('2d');
        const color=value=>{ctx.fillStyle='#ff00ff';ctx.fillStyle=value.trim();return ctx.fillStyle;};
        const token=(e,name)=>color(getComputedStyle(e).getPropertyValue('--'+name));
        if(!f||!r||!card||f.querySelector('[data-trigger-check-fields]').disabled||getComputedStyle(card).fontFamily==='Times New Roman'||document.scrollingElement.scrollWidth>${width})problems.push('form, fonts or page width');
        const rows=[...document.querySelectorAll('.tr')];
        if(!rows.length)problems.push('rule rows absent');
        for(const row of rows){
          for(const [selector,min] of [['.tr-when',${width<760?170:160}],['.tr-then',150],['.tr-status',${width<760?170:200}]]){
            const e=row.querySelector(selector),box=e&&e.getBoundingClientRect(),style=e&&getComputedStyle(e);
            if(!visible(e)||box.width<min||parseFloat(style.fontSize)<12||box.height<16)problems.push(selector+' compressed or unreadable: '+(box&&Math.round(box.width)));
          }
          const label=row.querySelector('.tr-when .tr-s');
          if(label&&(parseFloat(getComputedStyle(label).fontSize)<14||parseFloat(getComputedStyle(label).lineHeight)<20))problems.push('rule hierarchy lost');
          const flow=row.querySelector('.tr-flow');
          if(flow){const style=getComputedStyle(flow),spent=row.classList.contains('tr--spent');if(color(style.backgroundColor)!==token(flow,spent?'surface-3':'primary')||color(style.color)!==token(flow,spent?'ink':'on-primary')||parseFloat(style.borderRadius)<20||flow.getBoundingClientRect().height<24)problems.push('flow pill tokens or geometry');}
        }
        const desktop=document.querySelector('.tr-week-desktop'),phone=document.querySelector('.tr-week-phone');
        if(${width}<760){if(visible(desktop)||!visible(phone)||!phone.querySelector('.tr-next-fires')||!phone.textContent.includes('Next fires'))problems.push('phone schedule replacement');}
        else{
          if(!visible(desktop)||visible(phone))problems.push('desktop schedule visibility');
          const axes=[...document.querySelectorAll('.wk-ax')],ticks=[...document.querySelectorAll('.wk-day')],legend=document.querySelector('.tr-week-key');
          if(axes.length!==7||!axes.every(e=>parseFloat(getComputedStyle(e).fontSize)>=11&&color(getComputedStyle(e).fill)===token(e,'ink-faint')))problems.push('seven readable UTC axis labels');
          if(!ticks.length||!ticks.every(e=>color(getComputedStyle(e).stroke)===token(e,'line')&&parseFloat(getComputedStyle(e).strokeWidth)>=1))problems.push('day tick styling');
          if(!visible(legend)||!['recorded run','projected fire','quiet window'].every(t=>legend.textContent.includes(t)))problems.push('complete chart legend');
          for(const e of document.querySelectorAll('.wk-next')){const style=getComputedStyle(e);if(color(style.stroke)!==token(e,'running')||parseFloat(style.strokeWidth)<2||color(style.fill)!==token(e,'surface'))problems.push('future fire marks');}
          for(const e of document.querySelectorAll('.wk-quiet'))if(color(getComputedStyle(e).fill)!==token(e,'surface-3'))problems.push('quiet bands');
          for(const e of document.querySelectorAll('.wk-k')){
            const style=getComputedStyle(e);
            if(e.getBoundingClientRect().width<10||e.getBoundingClientRect().height<10)problems.push('legend marker geometry');
            if(e.classList.contains('wk-k--ran')&&color(style.backgroundColor)!==token(e,'ink-faint'))problems.push('recorded legend color');
            if(e.classList.contains('wk-k--quiet')&&(color(style.backgroundColor)!==token(e,'surface-3')||parseFloat(style.borderRadius)<4))problems.push('quiet legend color');
            if(e.classList.contains('wk-k--next')){const stroke=style.boxShadow.match(/rgba?\\([^)]*\\)/);if(!stroke||color(stroke[0])!==token(e,'running')||!style.boxShadow.includes('inset'))problems.push('future legend outline');}
          }
        }
        if(${JSON.stringify(role)}==='viewer'&&(document.querySelector('a[href="/config/trigger-add"]')||document.querySelector('form[data-action]')))problems.push('viewer write controls');
        return problems;
      })()`);
      ensure(!paint.length, `Trigger layout/style/role failures: ${paint.join('; ')}`);
    },{width,theme});
  const readOnlyDoc=docs.find(d=>d.file.endsWith("triggers-readonly.operator.html"));
  if(readOnlyDoc) await run("readonly-remains-checkable","triggers","operator",async({evaluate})=>{
    ensure(await evaluate(`(()=>{const form=document.querySelector('form[data-trigger-check]');return form&&!form.querySelector('[data-trigger-check-fields]').disabled&&!document.querySelector('a[href="/config/trigger-add"]')&&!document.querySelector('form[data-action]')&&document.body.textContent.includes('Changes are off');})()`),"Read-only deployment hides writes and keeps hypothetical checking available");
  },{docOverride:readOnlyDoc,width:800,theme:"dark"});
  await run("no-js-check-disabled","trigger-check","viewer",async({evaluate})=>{
    ensure(await evaluate(`(()=>{const f=document.querySelector('form[data-trigger-check]');return f&&f.querySelector('[data-trigger-check-fields]').disabled&&!f.getAttribute('action')&&!!document.querySelector('noscript');})()`),"Without JavaScript a hypothetical description could navigate into URL history");
  },{width:390,noScript:true});
  await run("forge-event-review-controls","trigger-check","operator",async({evaluate})=>{
    ensure(await evaluate(`(()=>{const f=document.querySelector('form[data-trigger-check]');const set=(name,value)=>{const e=f.querySelector('[name="'+name+'"]');e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));};for(const forge of ['github','gitlab','forgejo','azure']){set('forge',forge);for(const name of ['event','action']){const select=f.querySelector('[name="'+name+'"]'),o=select.selectedOptions[0];if(!o||o.disabled||o.hidden||o.dataset.checkForge!==forge)return false;}set('event','pull-request');if(forge==='azure'&&!f.querySelector('[name="labels"]').disabled)return false;if(forge!=='github'&&!f.querySelector('[name="prAuthor"]').disabled)return false;}set('forge','github');set('event','pull-request');set('action','review_submitted');return ['prAuthor','reviewState','reviewBody'].every(n=>!f.querySelector('[name="'+n+'"]').disabled)&&f.querySelector('[name="comment"]').disabled;})()`),"Forge-specific vocabularies or reviewer/author controls disagree with checker contract");
  });
  await run("viewer-check-preserves-private-input","trigger-check","viewer",async({evaluate,t})=>{
    await evaluate(`(()=>{window.__triggerPosts=[];window.__triggerReplies=[];const original=window.fetch;window.fetch=(url,init)=>{if(String(url)==='/api/trigger-check'){window.__triggerPosts.push({url:String(url),headers:init.headers,body:JSON.parse(init.body)});return new Promise(resolve=>window.__triggerReplies.push((status,body)=>resolve({ok:status===200,status,json:async()=>body})));}return original(url,init);};const f=document.querySelector('form[data-trigger-check]');f.querySelector('[name="repository"]').value='org/repo';const event=f.querySelector('[name="event"]');event.value='issue-comment';event.dispatchEvent(new Event('change',{bubbles:true}));const c=f.querySelector('[name="comment"]');c.value='@pi private-browser-canary';c.dispatchEvent(new Event('input',{bubbles:true}));f.querySelector('[type="submit"]').focus();})()`);
    await t.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r",unmodifiedText:"\r"});
    await t.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
    ensure(await evaluate(`window.__triggerPosts.length===1&&window.__triggerPosts[0].body.comment==='@pi private-browser-canary'&&Object.keys(window.__triggerPosts[0].headers).some(k=>k.toLowerCase()==='x-console-as')&&!location.href.includes('private-browser-canary')`),"Keyboard viewer check failed or private body entered navigation");
    await evaluate(`window.__triggerReplies[0](200,{html:'<p>Row 1 hypothetically matches. Authentication not checked.</p>'})`);
    ensure(await evaluate(`(()=>{const r=document.querySelector('[data-trigger-check-result]');return r.textContent.includes('hypothetically matches')&&document.activeElement===r&&document.querySelector('[name="comment"]').value==='@pi private-browser-canary';})()`),"Server result/focus/input preservation failed");
    await evaluate(`(()=>{const f=document.querySelector('form[data-trigger-check]');f.requestSubmit();const c=f.querySelector('[name="comment"]');c.value='changed-private-browser-canary';c.dispatchEvent(new Event('input',{bubbles:true}));window.__triggerReplies[1](200,{html:'<p>STALE-SERVER-ANSWER</p>'});})()`);
    ensure(await evaluate(`!document.querySelector('[data-trigger-check-result]').textContent.includes('STALE-SERVER-ANSWER')&&document.querySelector('[name="comment"]').value==='changed-private-browser-canary'`),"Stale answer replaced edited input state");
    await evaluate(`(()=>{document.querySelector('form[data-trigger-check]').requestSubmit();window.__triggerReplies[2](401,{html:'<img src=x onerror="window.__privateLeak=true">',error:'private-server-error'});})()`);
    ensure(await evaluate(`(()=>{const r=document.querySelector('[data-trigger-check-result]');return r.textContent.includes('session changed or ended')&&!r.innerHTML.includes('private-server-error')&&!r.querySelector('img')&&!window.__privateLeak;})()`),"Hostile session answer reached markup or lost session explanation");
  },{width:390,theme:"dark"});
  return results;
}
