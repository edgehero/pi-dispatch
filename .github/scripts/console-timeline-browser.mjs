/** #907: actual HTTP, auth, CSP, bundled vis, archive paging, gestures and navigation. No paid work. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openChrome } from "../../launch/chrome-pipe.mjs";
import { findChrome, chromeLaunchArgs } from "./console-width-check.mjs";
import { startTimelineBrowserFixture, TIMELINE_BROWSER_TOKENS, TIMELINE_AT } from "../../admin/test/helpers/timeline-browser.mjs";

export async function checkTimelineBrowser({ chrome, shots=null, count=10000, projects=4, benchmark=false, sandbox=process.env.GITHUB_ACTIONS!=="true" }={}) {
  const work=mkdtempSync(join(tmpdir(),"pd-timeline-browser-")),children=new Set(),errors=[];
  let fixture,browser,tab,stage="startup";
  try {
    mkdirSync(join(work,"app"));fixture=await startTimelineBrowserFixture(join(work,"app"),{count,projects});fixture.pauseTicks();
    mkdirSync(join(work,"chrome"));browser=await openChrome({chrome,work:join(work,"chrome"),children,env:{HOME:process.env.HOME},extraArgs:chromeLaunchArgs({sandbox}),resolverRules:"MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",captureStderr:true});
    tab=await browser.openTarget();await tab.send("Page.enable");await tab.send("Runtime.enable");await tab.send("Network.enable");
    await tab.send("Emulation.setTimezoneOverride",{timezoneId:"Europe/Amsterdam"});
    await tab.send("Page.addScriptToEvaluateOnNewDocument",{source:"window.timelineCsp=[];addEventListener('securitypolicyviolation',e=>timelineCsp.push(e.effectiveDirective+':'+e.blockedURI));"});
    browser.event(message=>{if(message.method==="Runtime.exceptionThrown")errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);return false;},"timeline diagnostics",300000).catch(()=>{});
    const evaluate=async expression=>{
      const r=await tab.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
      if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;
    };
    const until=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("Timed out: "+expression+"; state="+await evaluate("JSON.stringify({state:history.state,range:document.querySelector('[data-rt-range]')?.textContent,density:document.querySelector('[data-rt-density]')?.textContent})"));};
    const go=async path=>{const loaded=browser.event(m=>m.sessionId===tab.sessionId&&m.method==="Page.loadEventFired","timeline page load");loaded.catch(()=>{});await tab.send("Page.navigate",{url:fixture.origin+path});await loaded;await until("document.readyState==='complete'&&location.pathname==="+JSON.stringify(path.split("?")[0]));};
    const point=async selector=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    const click=async selector=>{const xy=await point(selector);for(const type of ["mousePressed","mouseReleased"])await tab.send("Input.dispatchMouseEvent",{type,...xy,button:"left",clickCount:1});};
    const press=async(key,code,n)=>{await tab.send("Input.dispatchKeyEvent",{type:"keyDown",key,code,windowsVirtualKeyCode:n});await tab.send("Input.dispatchKeyEvent",{type:"keyUp",key,code,windowsVirtualKeyCode:n});};
    const ready=async()=>{await until("!!document.querySelector('.vis-timeline')&&getComputedStyle(document.querySelector('.vis-timeline')).visibility==='visible'&&document.querySelector('[data-rt-status]').textContent.includes('Range read')");await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))");};
    const range=()=>evaluate("document.querySelector('[data-rt-range]').textContent");
    const capture=async name=>{
      if(!shots)return;mkdirSync(shots,{recursive:true});
      await evaluate("document.querySelector('#p-timeline').scrollIntoView({block:'start'})");
      const clip=await evaluate("(()=>{const r=document.querySelector('#p-timeline').getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()");
      const got=await tab.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,clip});writeFileSync(join(shots,name+".png"),Buffer.from(got.data,"base64"));
    };
    await go("/login");await evaluate(`document.querySelector('#token').value=${JSON.stringify(TIMELINE_BROWSER_TOKENS.viewer)}`);await click("#login-form button");await ready();
    if(benchmark){
      const initialMs=await evaluate("performance.now()"),samples=[];
      await evaluate("window.frameGaps=[];window.lastFrame=performance.now();window.sampleFrames=true;requestAnimationFrame(function sample(t){if(!sampleFrames)return;frameGaps.push(t-lastFrame);lastFrame=t;requestAnimationFrame(sample)});");
      for(let i=0;i<24;i++){
        const then=Date.now();await click(i%12<6?"[data-rt-action=older]":"[data-rt-action=newer]");await ready();
        const ms=Date.now()-then;
        if(i===11||i===23){
          await evaluate("window.sampleFrames=false");await tab.send("HeapProfiler.collectGarbage");
          samples.push({pan:i+1,rangeReadyMs:ms,heapBytes:(await tab.send("Runtime.getHeapUsage")).usedSize,...await tab.send("Memory.getDOMCounters"),visibleItems:await evaluate("document.querySelectorAll('.rt-run').length")});
          if(i===11)await evaluate("window.lastFrame=performance.now();window.sampleFrames=true;requestAnimationFrame(function sample(t){if(!sampleFrames)return;frameGaps.push(t-lastFrame);lastFrame=t;requestAnimationFrame(sample)});");
        }
      }
      const gaps=await evaluate("frameGaps.sort((a,b)=>a-b)");
      assert.ok(samples.every(s=>s.visibleItems<=650));
      assert.deepEqual(errors,[]);assert.deepEqual(await evaluate("timelineCsp"),[]);
      return {count,projects,initialReadyMs:Math.round(initialMs),samples,frameGapP95Ms:Math.round(gaps[Math.floor(gaps.length*.95)]),maxFrameGapMs:Math.round(gaps.at(-1)),historyRequests:fixture.calls.length,browser:await tab.send("Browser.getVersion")};
    }
    const paints=[];
    for(const width of [1440,390])for(const theme of ["light","dark"]){
      stage=`${width}/${theme}`;
      await tab.send("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});
      await go("/");await ready();await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await capture("overview-"+width+"-"+theme);
      const before=await range();await click("[data-rt-action=older]");await until("document.querySelector('[data-rt-mode]').textContent==='Browsing history'");
      assert.notEqual(await range(),before);
      const historical=await range();await fixture.refresh(5000);await new Promise(resolve=>setTimeout(resolve,300));assert.equal(await range(),historical,"SSE must preserve the historical viewport");
      await click("[data-rt-action=now]");await ready();await until("!!document.querySelector('[data-group=dense]')");
      await click("[data-group=dense]");await until("document.querySelector('[data-rt-density]').textContent.includes('of 250')");
      assert.equal(await evaluate("document.querySelectorAll('.rt-run[data-run]').length"),200);
      await click("[data-rt-action=next-page]");assert.equal(await evaluate("document.querySelectorAll('.rt-run[data-run]').length"),50);
      await evaluate("document.querySelector('[data-rt-chart]').focus()");await press("ArrowRight","ArrowRight",39);
      assert.equal(await evaluate("document.querySelector('[data-rt-preview]').hidden"),false);
      await capture("dense-"+width+"-"+theme);
      await until("history.state.runTimeline.expanded==='dense'&&history.state.runTimeline.detailPage===1");
      const prior=await range(),state=await evaluate("history.state.runTimeline");
      await click("[data-rt-preview] a");await until("location.pathname==='/run'");
      await evaluate("history.back()");await ready();
      assert.equal(await range(),prior);assert.equal(await evaluate("history.state.runTimeline.expanded"),state.expanded);assert.equal(await evaluate("history.state.runTimeline.detailPage"),state.detailPage);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
      assert.deepEqual(await evaluate("timelineCsp"),[]);
      paints.push({width,theme});
    }
    stage="keyboard reveals vertical lanes without changing time";
    await go("/");await ready();await click("[data-group=dense]");
    await evaluate("document.querySelector('[data-rt-chart]').focus()");const keyboardRange=await range();
    for(let i=0;i<16;i++)await press("ArrowRight","ArrowRight",39);
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(await range(),keyboardRange);
    assert.ok(await evaluate("(()=>{const b=document.activeElement.getBoundingClientRect(),c=document.querySelector('.vis-panel.vis-center').getBoundingClientRect();return !!document.activeElement.dataset.run&&b.top>=c.top-1&&b.bottom<=c.bottom+1})()"));
    stage="pointer and trackpad boundaries";
    await tab.send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await go("/");await ready();
    await evaluate("document.querySelector('[data-rt-chart]').scrollIntoView({block:'center'})");
    const xy=await point(".vis-panel.vis-center"),beforeDrag=await range();
    await tab.send("Input.dispatchMouseEvent",{type:"mouseMoved",...xy});await tab.send("Input.dispatchMouseEvent",{type:"mousePressed",...xy,button:"left",clickCount:1});
    for(let i=1;i<=15;i++)await tab.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:xy.x-i*10,y:xy.y,button:"left",buttons:1});
    await tab.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:xy.x-150,y:xy.y,button:"left",clickCount:1});
    assert.notEqual(await range(),beforeDrag);assert.equal(await evaluate("location.pathname"),"/","a drag never opens a run");
    const calls=fixture.calls.length;
    for(let i=0;i<3;i++){await click("[data-rt-action=older]");await ready();}
    assert.ok(fixture.calls.length>calls,"crossing range boundaries fetches history");
    const beforeWheel=await range(),wheel=await point(".vis-panel.vis-center");await tab.send("Input.dispatchMouseEvent",{type:"mouseWheel",...wheel,deltaX:-350,deltaY:0});
    await until("document.querySelector('[data-rt-range]').textContent!=="+JSON.stringify(beforeWheel));
    const beforeZoom=await range();await click("[data-rt-action=in]");assert.notEqual(await range(),beforeZoom);
    stage="winter and summer time";
    for(const [name,at,offsets] of [["autumn","2026-10-25T01:00:00Z",["GMT+2","GMT+1"]],["spring","2026-03-29T01:00:00Z",["GMT+1","GMT+2"]],["winter","2026-01-15T12:00:00Z",["GMT+1"]],["summer","2026-07-15T12:00:00Z",["GMT+2"]]]){
      await go("/?project=clock&zoom=1h&anchor="+Date.parse(at));await ready();
      await evaluate("document.querySelector('[data-rt-chart]').focus()");await press("ArrowRight","ArrowRight",39);
      const words=await evaluate("document.querySelector('[data-rt-preview]').textContent");for(const offset of offsets)assert.ok(words.includes(offset),words);
      if(name==="autumn"||name==="spring")assert.match(words,/3[,.]?600 seconds/);
      if(name==="autumn")await capture("autumn-desktop");
    }
    stage="UTC and repeated-hour axis";
    await tab.send("Emulation.setTimezoneOverride",{timezoneId:"UTC"});
    await go("/?project=clock&zoom=1h&anchor="+Date.parse("2026-10-25T01:00:00Z"));await ready();
    await evaluate("document.querySelector('[data-rt-chart]').focus()");await press("ArrowRight","ArrowRight",39);
    assert.equal(await evaluate("document.querySelector('[data-rt-zone]').textContent"),"UTC");
    assert.match(await evaluate("document.querySelector('[data-rt-preview]').textContent"),/3[,.]?600 seconds/);
    assert.ok(await evaluate("document.querySelector('[data-rt-chart]').textContent.includes('UTC+00:00')"));
    await tab.send("Emulation.setTimezoneOverride",{timezoneId:"Europe/Amsterdam"});
    await go("/?project=clock&zoom=1h&anchor="+Date.parse("2026-10-25T01:00:00Z"));await ready();
    const ticks=await evaluate("document.querySelector('[data-rt-chart]').textContent");
    assert.ok(ticks.includes('UTC+02:00')&&ticks.includes('UTC+01:00'),ticks);
    stage="cancelled reads and focused live updates";
    fixture.delay(250);await go("/");await until("!!document.querySelector('.vis-timeline')");
    for(let i=0;i<4;i++)await click("[data-rt-action=older]");
    fixture.delay(0);await ready();
    await evaluate("document.querySelector('[data-rt-chart]').focus()");await press("ArrowRight","ArrowRight",39);
    const focused=await evaluate("document.activeElement.dataset.run");assert.ok(focused);
    await fixture.refresh(5000);await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await evaluate("document.activeElement.dataset.run"),focused);
    stage="abandoned cursor resumes without losing records";
    await go("/?project=billing");await ready();
    await evaluate("const select=document.querySelector('[data-rt-span]');select.value='604800000';select.dispatchEvent(new Event('change',{bubbles:true}));");await ready();
    fixture.delay(200);const beforeRetry=fixture.calls.length;await click("[data-rt-action=retry]");
    for(let i=0;i<100&&fixture.calls.length<beforeRetry+2;i++)await new Promise(resolve=>setTimeout(resolve,25));
    await click("[data-rt-action=older]");await click("[data-rt-action=newer]");fixture.delay(0);await ready();
    await click("[data-group=billing]");
    const restored=await evaluate("history.state.runTimeline"),expected=fixture.rows.filter(r=>r.project==='billing'&&r.startedAt<restored.end&&r.endedAt>=restored.start).length;
    await until("document.querySelector('[data-rt-density]').textContent.includes('of "+expected+" loaded')");
    stage="touch pan and explicit open";
    await tab.send("Emulation.setDeviceMetricsOverride",{width:390,height:1000,deviceScaleFactor:1,mobile:true});
    await tab.send("Emulation.setTouchEmulationEnabled",{enabled:true});
    await go("/");await ready();
    const touch=await point(".vis-panel.vis-center"),beforeTouch=await range();
    await tab.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[touch]});
    for(let i=1;i<=10;i++)await tab.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:touch.x-i*10,y:touch.y}]});
    await tab.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    assert.notEqual(await range(),beforeTouch);assert.equal(await evaluate("location.pathname"),"/");
    await click("[data-rt-action=now]");await ready();
    await point("[data-rt-chart]");
    const hit=await evaluate("(()=>{for(const b of document.querySelectorAll('.rt-run[data-run]')){if(b.closest('.rt-aggregate'))continue;const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(x>0&&x<innerWidth&&y>0&&y<innerHeight&&document.elementFromPoint(x,y)?.closest('[data-run]')===b)return{x,y};}throw new Error('No selectable run at phone width')})()");
    await tab.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[hit]});
    await tab.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await until("!document.querySelector('[data-rt-preview]').hidden");
    assert.equal(await evaluate("location.pathname"),"/","touch previews before opening");
    await click("[data-rt-preview] a");await until("location.pathname==='/run'");
    await tab.send("Emulation.setTouchEmulationEnabled",{enabled:false});
    await tab.send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    stage="offline source and retry";fixture.offline(true);
    await go("/?anchor="+(TIMELINE_AT-5*86400000));await until("document.querySelector('[data-rt-status]')?.textContent.includes('Unavailable: build3')");
    fixture.offline(false);await click("[data-rt-action=retry]");await ready();
    stage="hostile text";await go("/");await ready();await click("[data-group=dense]");
    await evaluate("[...document.querySelectorAll('[data-run]')].find(b=>b.dataset.run.includes('gh-timeline-0\"')).focus()");
    assert.equal(await evaluate("document.querySelector('[data-rt-preview] img')===null&&!window.timelineInjected"),true);
    assert.match(await evaluate("document.querySelector('[data-rt-preview]').textContent"),/<img src=x/);
    assert.deepEqual(errors,[]);assert.deepEqual(await evaluate("timelineCsp"),[]);
    return {paints,historyRequests:fixture.calls.length,checks:"real CSP/auth, local assets, pointer/trackpad/touch pan, cancelled reads, preserved focus, zoom, dense expansion and paging, keyboard inspection, detail/Back, stable SSE, UTC and DST axis/preview offsets and durations, offline retry, hostile text"};
  }catch(error){throw new Error(`Timeline browser ${stage}: ${error.message}; exceptions=${JSON.stringify(errors)}`,{cause:error});}
  finally{if(tab)await tab.close().catch(()=>{});if(browser){await browser.close();browser.removeSingleton();}for(const child of children)child.kill("SIGKILL");await fixture?.close();rmSync(work,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const chrome=findChrome();if(!chrome?.path){if(process.argv.includes("--require"))throw new Error("Chrome is required");console.log("SKIP: Chrome is unavailable");}else{const at=process.argv.indexOf("--shots");if(process.argv.includes("--benchmark")){for(const count of [1000,10000,50000])console.log(JSON.stringify(await checkTimelineBrowser({chrome:chrome.path,count,projects:100,benchmark:true})));}else console.log(JSON.stringify(await checkTimelineBrowser({chrome:chrome.path,shots:at<0?null:process.argv[at+1]})));}}
