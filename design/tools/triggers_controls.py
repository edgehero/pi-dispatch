"""Published Triggers screen styles; pasted byte for byte into the console (#750)."""
TRIGGERS_CSS = """
.tr-tabs { margin: var(--space-2) 0 var(--space-2); }
.tr-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.tr-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.tr-kp { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; color: var(--ink-muted); }
.tr-kp > span { display: inline-flex; align-items: center; gap: 5px; }
.tr-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.tr-filters .fpill b { margin-left: 2px; }
.tr-list { display: grid; }
.tr { display: grid; grid-template-columns: 28px minmax(0, 1.25fr) 20px minmax(0, 1fr) 230px 40px; gap: 6px var(--space-3); align-items: start;
      padding: var(--space-4) var(--space-5); border-top: 1px solid var(--line); }
.tr-list .tr:first-child { border-top: 0; }
.tr-n { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--surface-2); color: var(--ink); font-size: 13px; font-weight: 750; font-variant-numeric: tabular-nums; }
.tr-n--sm { width: 22px; height: 22px; font-size: 11px; flex: none; }
.tr-when { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; }
.tr-kind { background: var(--surface-2); color: var(--ink); }
.tr-k { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.tr-s { font-size: 15px; line-height: 22px; font-weight: 650; color: var(--ink); }
.tr-sub { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tr-arrow { color: var(--ink-faint); padding-top: 22px; }
.tr-then { display: grid; gap: 4px; padding-top: 18px; }
.tr-flow { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px 0 8px; border-radius: var(--radius-pill); background: var(--primary); color: var(--on-primary); font-size: 13px; font-weight: 700; vertical-align: 1px; }
.tr-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.tr-status { display: grid; gap: 3px; padding-top: 2px; }
.tr-status > p:first-child { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tr-t { font-size: 13px; font-weight: 600; color: var(--ink); }
.tr-status .chip { height: 22px; vertical-align: middle; }
.tr-act { padding-top: 2px; }
.tr-note { grid-column: 2 / -1; display: flex; gap: 8px; align-items: flex-start; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tr-note .ic { flex: none; margin-top: 2px; color: var(--ink); }
.tr--spent { background: repeating-linear-gradient(135deg, transparent 0 10px, var(--surface-2) 10px 11px); }
.tr--spent .tr-flow { background: var(--surface-3); color: var(--ink); }
.wk { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; margin-top: 34px; }
.wk-labels { display: grid; grid-template-rows: repeat(3, 36px); align-items: center; }
.wk-labels p { display: grid; font-size: 12px; line-height: 15px; }
.wk-labels b { color: var(--ink); font-weight: 700; }
.wk-labels span { color: var(--ink-muted); }
.wk-track { position: relative; min-width: 0; }
.wk-svg { width: 100%; display: block; overflow: visible; }
.wk-band { fill: var(--surface-2); }
.wk-day { stroke: var(--line); stroke-width: 1; }
.wk-quiet { fill: var(--surface-3); }
.wk-ran { fill: var(--ink-faint); }
.wk-next { fill: var(--surface); stroke: var(--running); stroke-width: 2; }
.wk-l { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.wk-now { stroke: var(--ink); stroke-width: 2; }
.wk-ax { font-size: 11px; fill: var(--ink-faint); }
.wk-cap { position: absolute; top: -24px; left: 9.315%; transform: translateX(-50%); height: 20px; padding: 0 8px; border-radius: 10px; background: var(--primary); color: var(--on-primary); font-size: 11px; font-weight: 700; line-height: 20px; }
.wk-k { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.wk-k--ran { background: var(--ink-faint); }
.wk-k--next { box-shadow: inset 0 0 0 2px var(--running); }
.wk-k--quiet { width: 18px; border-radius: 5px; background: var(--surface-3); }
.tr-p { font-size: 13px; margin-bottom: var(--space-3); }
.tr-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.tr-span { grid-column: 1 / -1; }
.tr-btnrow { margin: var(--space-3) 0; }
.tr-result { display: grid; gap: 8px; padding: var(--space-4); border-radius: var(--radius-md); background: var(--ok-tint); }
.tr-res__h { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; color: var(--ink); }
.tr-res__h .ic { color: var(--ok-ink); }
.tr-res__s { font-size: 13px; line-height: 20px; color: var(--ink); }
.tr-res__k { font-size: 12px; font-weight: 700; color: var(--ink); margin-top: 4px; }
.tr-why { display: grid; gap: 6px; }
.tr-why li { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.tr-why .tr-n { background: var(--surface); }
.tr-gates { display: grid; gap: 4px; }
.tr-gates li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 6px; align-items: baseline; font-size: 12px; color: var(--ink); }
.tr-gates .ic { color: var(--ok-ink); align-self: center; }
.tr-gates span { color: var(--ink); }
@media (max-width: 1200px) { .tr { grid-template-columns: 28px minmax(0, 1fr) 20px minmax(0, 1fr) 40px; } .tr-status { grid-column: 2 / -2; } }
@media (max-width: 760px) {
  .tr { grid-template-columns: 28px minmax(0, 1fr) 36px; padding: var(--space-4); }
  .tr-when { grid-column: 2; } .tr-act { grid-column: 3; grid-row: 1; }
  .tr-arrow { display: none; }
  .tr-then, .tr-status, .tr-note { grid-column: 2 / -1; padding-top: 0; }
  .wk-scroll { overflow-x: auto; margin: 0 calc(-1 * var(--space-5)); padding: 0 var(--space-5); }
  .wk { grid-template-columns: 110px minmax(0, 1fr); min-width: 600px; }
  .tr-form { grid-template-columns: minmax(0, 1fr); }
  .tr-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .tr-filters { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
}


.tp-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: var(--space-4); }
.tp-kpis p { display: grid; gap: 2px; }
.tp-kpis b { font-size: 20px; line-height: 24px; font-weight: 800; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.tp-kpis span { font-size: 12px; color: var(--ink-muted); }
.tp-list { display: grid; }
.tp { display: grid; gap: 6px; padding: var(--space-4); border-top: 1px solid var(--line); }
.tp-list .tp:first-child { border-top: 0; }
.tp-h { display: flex; align-items: center; gap: 10px; }
.tp-k { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.tp-open { margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; color: var(--ink-muted); }
.tp-when { font-size: 15px; line-height: 22px; font-weight: 650; color: var(--ink); }
.tp-then { font-size: 14px; color: var(--ink); }
.tp-last { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tp-t { font-size: 13px; font-weight: 600; color: var(--ink); }
.tp-next { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink); font-weight: 600; }
.tp-note summary { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); cursor: pointer; }
.tp-note p { margin-top: 6px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tp--spent { background: repeating-linear-gradient(135deg, transparent 0 10px, var(--surface-2) 10px 11px); }
.tp--spent .tr-flow { background: var(--surface-3); color: var(--ink); }
.tp-fires { display: grid; gap: 8px; }
.tp-fires li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.tp-fires__w { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 14px; }
.tp-fires__w b { color: var(--ink); font-variant-numeric: tabular-nums; }
.tp-fires__w span { font-size: 12px; color: var(--ink-muted); }
.tp-fires__r { grid-column: 1; display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.tp-fires li > .chip { grid-column: 2; grid-row: 1 / span 2; }
.tp-fires li.tp-fires--quiet { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
#p-tr-check .btn { width: 100%; justify-content: center; }

/* One semantic rule row adapts to every width; the chart and phone list share source facts. */
.triggers-layout{align-items:start;grid-template-columns:minmax(0,1.8fr) minmax(340px,1fr)}
.triggers-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-5);margin-bottom:var(--space-5)}
.triggers-rules,.triggers-check-side{min-width:0}
.triggers-kpis .kpi b{overflow-wrap:anywhere;font-size:28px;line-height:1.2}
.triggers-kpis .tr-problem{font-size:12px;line-height:18px}
.triggers-kpis .card{height:100%}
.triggers-layout .tr{grid-template-columns:28px minmax(0,1.25fr) 20px minmax(0,1fr) 200px 32px}
.triggers-layout .tr-open{padding:0;width:30px;min-width:30px}
.tr-s a{color:inherit;text-decoration:none}
.tr-s a:hover{text-decoration:underline}
.tr-flow{height:auto;min-height:26px;white-space:normal;overflow-wrap:anywhere;max-width:100%}
.tr-chips .chip{height:auto;min-height:24px;white-space:normal;overflow-wrap:anywhere;padding-top:3px;padding-bottom:3px}
.tr-status .code{white-space:normal;overflow-wrap:anywhere}
.tr-next{font-size:12px;line-height:18px;color:var(--ink);font-weight:600}
.tr-problem{font-size:12px;line-height:18px;color:var(--ink-muted);display:flex;align-items:flex-start;gap:6px}
.tr-problem .ic{flex:none}
.tr-empty{font-size:13px;line-height:20px;color:var(--ink-muted)}
.tr-note-phone,.tr-week-phone,.tr-check-phone-link{display:none}
.tr-note-desktop{margin:0}
.tr--spent .tr-when .tr-s{text-decoration:line-through;text-decoration-color:var(--ink-faint)}
.tr-tab-unavailable{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;color:var(--ink-muted);font-size:13px}
.tr-viewer{margin-bottom:var(--space-4)}
.wk-labels p{height:36px;overflow-wrap:anywhere;min-width:0}
.wk-now-label{fill:var(--ink);font:650 11px var(--font-sans)}
.wk-k{flex:none}
.tr-week-key{flex-wrap:wrap}
.tr-next-fires{display:grid;gap:10px;margin-bottom:var(--space-3)}
.tr-next-fires li{display:grid;gap:5px;padding:12px;border-radius:var(--radius-md);background:var(--surface-2)}
.tr-next-fires a{font-size:13px;overflow-wrap:anywhere}
.tr-next-fires span{font-size:12px;color:var(--ink-muted)}
form[data-trigger-check]{min-width:0}
[data-trigger-check-fields]{border:0;padding:0;margin:0;min-width:0}
[data-trigger-check-fields] .tr-sub{margin:12px 0}
[data-trigger-check-fields] input,[data-trigger-check-fields] textarea,[data-trigger-check-fields] select{box-sizing:border-box;min-width:0;max-width:100%}
[data-trigger-check-fields] textarea{height:auto}
[data-trigger-check-result]{margin-top:var(--space-4);outline-offset:4px;min-width:0}
[data-trigger-check-result]:focus-visible{outline:2px solid var(--primary)}
.tr-check-error{padding:var(--space-4);border-radius:var(--radius-md);background:var(--failed-tint);display:grid;gap:8px}
.tr-check-error h3{display:flex;gap:8px;align-items:center}
.tr-check-error p{font-size:13px;line-height:20px}
.tr-result h3,.tr-result h4{margin:0}
.tr-result .tr-why{padding:0;list-style:none}
.tr-result .tr-gates{padding:0;list-style:none}
.tr-result .tr-gates li{grid-template-columns:auto minmax(0,1fr);align-items:start}
.tr-result .tr-gates span{grid-column:2}
.tr-result .tr-gates b,.tr-result .tr-gates span{overflow-wrap:anywhere}
.tr-result .tr-res__h{align-items:flex-start}
@media(max-width:1500px){.triggers-layout .tr{grid-template-columns:28px minmax(0,1fr) 20px minmax(0,1fr) 32px}.triggers-layout .tr-status{grid-column:2/-2}}
@media(max-width:1100px){.triggers-layout{grid-template-columns:minmax(0,1fr)!important}.triggers-layout .tr{grid-template-columns:28px minmax(0,1.25fr) 20px minmax(0,1fr) 200px 32px}.triggers-layout .tr-status{grid-column:auto}}
@media(max-width:760px){
.triggers-kpis{grid-template-columns:minmax(0,1fr);gap:8px;margin-bottom:16px}.triggers-kpis .card{padding:12px}.triggers-kpis .card__head{margin-bottom:6px}.triggers-kpis .card__head h2{font-size:12px}.triggers-kpis .kpi b{font-size:18px;line-height:24px}.triggers-kpis .kpi span,.triggers-kpis .tr-kp{font-size:11px;line-height:16px}.triggers-kpis .tr-problem{font-size:11px}
.triggers-layout .triggers-check-side{grid-row:1}.triggers-layout .tr{grid-template-columns:28px minmax(0,1fr) 32px}.triggers-layout .tr-open{grid-column:3;grid-row:1}.triggers-layout .tr-when{grid-column:2}.triggers-layout .tr-then,.triggers-layout .tr-status,.triggers-layout .tr-note{grid-column:2/-1}
.tr-note-desktop,.tr-week-desktop,.tr-check-embedded{display:none}.tr-note-phone,.tr-week-phone,.tr-check-phone-link{display:block}.tr-note-phone summary{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}.tr-note-phone p{margin-top:8px;line-height:18px}
.tr-tabs{max-width:100%;min-width:0}.tr-week-phone{font-size:13px;line-height:20px}.tr-week-phone h3{margin-bottom:12px}.tr-week-phone>p{margin-bottom:10px}
.tr-filters{max-width:100%;min-width:0}.tr-filters .fpill{flex:none}
}
"""
