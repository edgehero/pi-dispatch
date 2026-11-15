import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatedTimelineAssets } from "../../.github/scripts/timeline-assets.mjs";
import { getTimeline, parseHistoryQuery, makeTimelineReader } from "../src/console/history-api.mjs";
import { timelineRecord, timelineSeed } from "../src/console/timeline-data.mjs";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const query = (extra={}) => new URLSearchParams({ format:"data",start:String(NOW-3600000),end:String(NOW),...extra });
const row = (over={}) => ({ jobId:"gh-a",host:"host-a",project:"web",outcome:"completed",startedAt:NOW-1000,endedAt:NOW,...over });

test("served timeline assets are reproducible from the pinned browser packages and source",async()=>{
  assert.equal(readFileSync(new URL("../src/console/timeline-assets.generated.mjs",import.meta.url),"utf8"),await generatedTimelineAssets());
  const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url)));
  for(const name of ["vis-timeline","vis-data","moment"]) assert.match(pkg.devDependencies[name],/^\d+\.\d+\.\d+$/);
});

test("arbitrary visible ranges stay bounded and refuse malformed inputs before any archive read",()=>{
  assert.deepEqual(parseHistoryQuery(query(),NOW),{format:"data",start:NOW-3600000,end:NOW,project:null,cursor:null});
  for(const extra of [{start:"NaN"},{start:"-1"},{start:String(NOW)},{end:String(NOW+8*86400000)},{project:"../secrets"},{host:"another"},{cursor:"oops"},{start:String(NOW-8*86400000)}])assert.equal(parseHistoryQuery(query(extra),NOW),null,JSON.stringify(extra));
  const duplicate=query();duplicate.append("start",String(NOW-3600000));assert.equal(parseHistoryQuery(duplicate,NOW),null);
});

test("structured history contains only projected metadata with correctly bound host detail links",async()=>{
  const fleet={historySources:async()=>({hosts:[]}),historyPage:async()=>({runs:[row({target:"<img src=x onerror=alert(1)>",transcript:"must not cross",path:"/private/key"})],next:null})};
  const ctx={deps:{now:()=>NOW,pageDeps:{fleet}},session:{name:"alice",role:"viewer"},searchParams:query(),json:(status,body)=>({status,body})};
  const response=await getTimeline(ctx);
  assert.equal(response.status,200);assert.equal(response.body.items.length,1);
  const r=response.body.items[0];assert.equal(r.href,"/run?id=gh-a&historyHost=host-a");
  assert.equal(r.target,"<img src=x onerror=alert(1)>","text stays data, the browser inserts it with textContent");
  assert.equal(r.transcript,undefined);assert.equal(r.path,undefined);
  assert.notEqual(timelineRecord(row({host:"host-b"})).id,r.id,"equal job ids on different hosts keep their origin");
});

test("data continuations bind the role and requested range; failed sources remain visible",async()=>{
  const read=makeTimelineReader({now:()=>NOW,fleet:{historySources:async()=>({hosts:["offline"]}),historyPage:async({host})=>host==="offline"?{error:"host-unavailable"}:{runs:[],next:null}}});
  const q=parseHistoryQuery(query(),NOW),first=await read(q,"a.viewer");
  assert.equal((await read({...q,cursor:first.next},"a.operator")).error,"cursor-expired");
  assert.equal((await read({...q,start:q.start-1,cursor:first.next},"a.viewer")).error,"cursor-expired");
  const second=await read({...q,cursor:first.next},"a.viewer");
  assert.equal(second.partial,true);assert.deepEqual(second.unavailable,["offline"]);
  const last=await read({...q,cursor:second.next},"a.viewer");assert.equal(last.next,null);assert.equal(last.partial,true);
});

test("the structured projection preserves elapsed time and unknown timestamps across autumn fallback",()=>{
  const a=Date.parse("2026-10-25T00:30:00Z"),b=Date.parse("2026-10-25T01:30:00Z");
  const r=timelineRecord(row({startedAt:a,endedAt:b}));assert.equal(r.end-r.start,3600000);
  const unknown=timelineRecord(row({startedAt:null}));assert.equal(unknown.startedAt,null);assert.equal(unknown.start,unknown.endedAt);
  const question=timelineRecord(row({reason:"awaiting-input"}));assert.equal(question.word,"requested input");
  const seed=timelineSeed({now:NOW,start:NOW-3600000,runs:[],active:[{jobId:"gh-live",startedAt:NOW-1000}],hostJobs:[{name:"host-a",jobs:[{id:"gh-live",p:"web",at:NOW-1000}]}],waiting:{rows:[{jobId:"gh-wait",project:"web",dueAt:NOW+1000}]},parked:[]});
  assert.deepEqual(seed.map(r=>r.kind),["run","wait"]);assert.ok(seed.every(r=>r.endedAt===null));
});
