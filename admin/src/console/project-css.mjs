/** ProjectDetail's chart and responsive rows, using the published Pulse tokens (#751). */
export const PROJECT_CSS = String.raw`
.proj-kv { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:var(--space-3); }
.proj-kv b { font-size:32px; line-height:36px; font-weight:800; letter-spacing:-.02em; }
.proj-kv>span { color:var(--ink-muted); font-size:13px; }
.proj-meter-label { margin-top:var(--space-2); font-size:12px; color:var(--ink-muted); text-align:right; }
.proj-note { margin-top:var(--space-3); font-size:13px; line-height:20px; overflow-wrap:anywhere; }
.proj-state { display:flex; gap:6px; align-items:flex-start; flex-wrap:wrap; font-size:13px; line-height:20px; }
.proj-state .ic { flex:none; margin-top:3px; }
.proj-state>span { min-width:0; flex:1; overflow-wrap:anywhere; }
.proj-members .rowpill { flex-wrap:wrap; height:auto; min-height:38px; padding:8px 12px; border-radius:var(--radius-md); }
.proj-members .rowpill>.code { flex:1 1 auto; white-space:normal; overflow:visible; overflow-wrap:anywhere; }
.proj-members .end { flex:0 1 auto; min-width:0; max-width:100%; flex-wrap:wrap; white-space:normal; overflow-wrap:anywhere; font-size:12px; }
.proj-members .end time { min-width:0; white-space:normal; overflow-wrap:anywhere; }
.project-kpis>[data-panel]>.card { height:100%; box-sizing:border-box; }
.proj-chart-unit { color:var(--ink-muted); font-size:11px; line-height:14px; margin-top:var(--space-2); }
.proj-chart { display:block; width:100%; height:auto; min-height:150px; }
.proj-grid { stroke:var(--line); stroke-width:1; }
.proj-axis { fill:var(--ink-muted); font-family:var(--font-sans); font-size:11px; }
.proj-given { stroke:var(--ink-muted); stroke-width:2; }
.proj-suggested { stroke:var(--attention); stroke-width:2; stroke-dasharray:6 5; }
.proj-peak { fill:var(--running); }
.proj-peak--oom { fill:var(--failed); stroke:var(--failed-ink); stroke-width:1; }
.proj-key { display:flex; flex-wrap:wrap; gap:8px 16px; font-size:12px; color:var(--ink-muted); }
.proj-key span { display:inline-flex; align-items:center; gap:6px; }
.proj-key i { display:inline-block; width:16px; border-top:2px solid var(--ink-muted); }
.proj-key .proj-key-peak,.proj-key .proj-key-oom { width:9px; height:9px; border:0; border-radius:50%; background:var(--running); }
.proj-key .proj-key-oom { background:var(--failed); }
.proj-key .proj-key-suggested { border-top:2px dashed var(--attention); }
.proj-verdict { margin-top:var(--space-3); font-size:13px; line-height:20px; }
.proj-sub { margin-top:var(--space-4); margin-bottom:var(--space-2); font-size:12px; font-weight:700; color:var(--ink-muted); }
.proj-refusal { display:flex; gap:6px; align-items:flex-start; border-radius:var(--radius-md); padding:var(--space-3); background:var(--attention-tint); color:var(--attention-ink); font-size:13px; line-height:20px; overflow-wrap:anywhere; }
.proj-refusal .ic { flex:none; margin-top:3px; }
.proj-refusal span { min-width:0; }
.proj-refusal+.btn { margin-top:var(--space-3); }
[data-page="project"] a.code { color:var(--focus); }
#p-proj-members .config-form { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:var(--space-3); align-items:center; }
#p-proj-members .config-form .field,#p-proj-members .config-form>noscript,#p-proj-members .config-form>[data-form-error] { grid-column:1/-1; }
#p-proj-members .config-form .btn { grid-column:1; grid-row:2; width:auto; justify-self:start; }
.proj-edit-hint { grid-column:2; grid-row:2; min-width:0; font-size:12px; line-height:18px; color:var(--ink-muted); }
.proj-triggers .rowpill { flex-wrap:wrap; min-width:0; padding:8px 12px; border-radius:var(--radius-md); }
.proj-triggers .rowpill>a { flex:0 0 auto; white-space:nowrap; }
.proj-triggers .proj-trigger-desc { flex:1 1 100px; min-width:0; white-space:normal; overflow-wrap:anywhere; }
.proj-triggers .end { flex:0 0 auto; margin-left:auto; white-space:nowrap; }
.proj-target { overflow-wrap:anywhere; }
[data-page="project"] .fact { overflow-wrap:anywhere; }
@media(max-width:1100px) { [data-page="project"] .project-layout { grid-template-columns:minmax(0,1fr); } .proj-members .end { flex-basis:calc(100% - 24px); max-width:calc(100% - 24px); margin-left:24px; } }
@media(max-width:900px) { [data-page="project"] .project-kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } .project-kpis>[data-panel]:last-child { grid-column:1/-1; } }
/* SVG text scales with its viewBox; counter that shrink on phones, while the unit stays ordinary HTML. */
@media(max-width:760px) { [data-page="project"] .project-kpis { grid-template-columns:minmax(0,1fr); } [data-page="project"] .tbl td { font-size:12px; white-space:normal; overflow-wrap:anywhere; } #p-proj-recent .tbl td:first-child { grid-column:1; grid-row:1; } #p-proj-recent .tbl td:nth-child(3) { grid-column:2; grid-row:1; } #p-proj-recent .tbl td:nth-child(2) { grid-column:1/-1; } #p-proj-recent .tbl .code { white-space:normal; overflow-wrap:anywhere; } .proj-chart { min-height:120px; } .proj-axis { font-size:calc(34px - 3vw); } }
`;
