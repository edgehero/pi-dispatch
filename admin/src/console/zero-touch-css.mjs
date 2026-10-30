/** Zero touch card styles, pasted from gen_zerotouch.py (#770). */
export const ZERO_TOUCH_CSS = `
.zt-tabs { margin: var(--space-2) 0; }
.zt-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.zt-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.zt-kp { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: var(--space-3); }
.zt-kt { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.zt-kt--ok { color: var(--ok-ink); }
.zt-cause { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 600; color: var(--ink); }
.zt-cause .ic { color: var(--tone-ink); }
.zt-q__d { font-size: 12px; color: var(--ink-muted); margin-left: 6px; }
.zt-kps { font-size: 13px; line-height: 19px; color: var(--ink-muted); margin-top: 6px; }
.zt-kps b { color: var(--ink); }
.zt-spark { display: block; width: 100%; height: 64px; overflow: visible; }
.zt-spark__goal { stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 4; vector-effect: non-scaling-stroke; }
.zt-spark__l { fill: none; stroke: var(--ink); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.zt-spark__d { fill: var(--ink); }
.zt-spark__ax { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--ink-faint); }

/* by project */
.zt-tbl { padding: 0 0 var(--space-2); }
.zt-row { display: grid; grid-template-columns: 18px minmax(0, 1.1fr) minmax(0, 1.4fr) 128px 104px 110px minmax(0, 1.25fr); gap: var(--space-3); align-items: center; padding: 12px var(--space-5); }
.zt-row--head { padding-top: 0; padding-bottom: 8px; font-size: 11px; line-height: 14px; font-weight: 650; color: var(--ink-faint); border-bottom: 1px solid var(--line); }
.zt-list > li { border-bottom: 1px solid var(--line); }
.zt-p > summary { list-style: none; cursor: pointer; }
.zt-p > summary::-webkit-details-marker { display: none; }
.zt-p > summary:hover { background: var(--surface-2); }
.zt-chev { color: var(--ink-faint); display: inline-flex; }
.zt-chev .ic { transition: transform .15s; }
.zt-p[open] > summary .zt-chev .ic { transform: rotate(90deg); }
.zt-name { display: grid; min-width: 0; }
.zt-name b { font-size: 15px; font-weight: 700; }
.zt-name small { font-size: 12px; line-height: 16px; color: var(--ink-muted); overflow-wrap: anywhere; }
.zt-m { display: grid; gap: 4px; min-width: 0; }
.zt-goal { stroke: var(--ink); stroke-width: 2; }
.zt-mv { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.zt-mv b { font-size: 15px; font-weight: 750; }
.zt-lv { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 650; color: var(--tone-ink); }
.zt-tr { display: inline-grid; grid-template-columns: auto auto; justify-content: start; gap: 0 5px; align-items: center; font-size: 13px; color: var(--tone-ink, var(--ink-muted)); }
.zt-tr b { font-weight: 650; }
.zt-tr small { grid-column: 2; font-size: 11px; color: var(--ink-muted); }
.zt-n { font-size: 13px; color: var(--ink-muted); }
.zt-n b { color: var(--ink); font-weight: 700; }
.zt-st { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--ink); }
.zt-st.tone-parked { color: var(--tone-ink); font-weight: 650; }
.zt-c { min-width: 0; }
.zt-c .chip b { color: inherit; }
.zt-subs { background: var(--surface-2); }
.zt-row--sub { padding-top: 10px; padding-bottom: 10px; border-top: 1px solid var(--line); }
.zt-row--sub .zt-name { padding-left: 4px; }
.zt-foot { display: flex; gap: 8px; align-items: flex-start; padding: var(--space-3) var(--space-5) var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.zt-foot .ic { flex: none; margin-top: 2px; }
.zt-foot--in { padding: var(--space-3) 0 0; }

/* causes */
.zt-bars { display: grid; gap: 10px; }
.zt-cb { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: var(--space-3); align-items: center; }
.zt-cb__n { display: grid; font-size: 13px; line-height: 16px; }
.zt-cb__n small { font-size: 11px; color: var(--ink-muted); }
.zt-cb__t { display: none; }
#p-zt-causes .zt-cb { grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
#p-zt-causes .zt-seg .ic { display: none; }
#p-zt-causes .zt-cb__t { display: block; grid-column: 2; margin-top: -4px; font-size: 11px; line-height: 15px; color: var(--ink-muted); }
#p-zt-causes .zt-whys { grid-template-columns: minmax(0, 1fr); }
#p-zt-causes .zt-why--sum { grid-column: 1; }
.zt-bar { display: flex; gap: 3px; height: 28px; }
.zt-seg { display: inline-flex; align-items: center; justify-content: center; gap: 3px; min-width: 0; border-radius: 8px; background: var(--tone); color: var(--on-tone); font-size: 12px; overflow: hidden; }
.zt-seg b { font-weight: 750; }
.zt-seg--rest { background: transparent; }
.zt-w1 { flex: 1 1 0; } .zt-w2 { flex: 2 1 0; } .zt-w3 { flex: 3 1 0; } .zt-w4 { flex: 4 1 0; } .zt-w5 { flex: 5 1 0; } .zt-w6 { flex: 6 1 0; }
.zt-w7 { flex: 7 1 0; } .zt-w8 { flex: 8 1 0; } .zt-w9 { flex: 9 1 0; } .zt-w10 { flex: 10 1 0; } .zt-w11 { flex: 11 1 0; } .zt-w12 { flex: 12 1 0; } .zt-w13 { flex: 13 1 0; }
.zt-whys { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px var(--space-5); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.zt-why { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; }
.zt-why > span:nth-child(2) { display: grid; font-size: 13px; line-height: 17px; }
.zt-why small { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.zt-why__n { font-size: 17px; font-weight: 750; min-width: 24px; text-align: right; }
.zt-why .tile { background: var(--tone); color: var(--on-tone); }
.zt-why--sum { grid-column: 2; border-top: 1px solid var(--line-strong); }
.zt-why--sum > span:first-child { width: 28px; }
.zt-merge { display: flex; gap: 8px; align-items: flex-start; margin-top: var(--space-4); padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.zt-merge .ic { flex: none; margin-top: 3px; color: var(--ink); }
.zt-merge b { color: var(--ink); }

/* questions */
p.zt-intro { font-size: 13px; color: var(--ink-muted); margin-bottom: var(--space-3); }
.zt-qs { display: grid; }
.zt-q { display: grid; gap: 10px; padding: var(--space-4) 0; border-top: 1px solid var(--line); }
.zt-q__h { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: var(--space-3); align-items: start; }
.zt-q__n { display: inline-flex; align-items: center; justify-content: center; height: 34px; border-radius: 12px; background: var(--surface-2); font-size: 15px; font-weight: 800; }
.zt-q__t { font-size: 15px; line-height: 21px; font-weight: 700; }
.zt-q__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.zt-q__s .code { font-size: 12px; color: var(--ink); }
.zt-said { display: flex; gap: 8px; align-items: flex-start; margin-left: calc(48px + var(--space-3)); font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.zt-said .ic { flex: none; margin-top: 3px; }
.zt-said .link.code { font-size: 12px; }
.zt-q__t--un { color: var(--ink-muted); font-weight: 650; }
.zt-q__act { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-left: calc(48px + var(--space-3)); }
.zt-q .confirm { margin-left: calc(48px + var(--space-3)); }
.zt-q .diff__b > span { white-space: pre-wrap; overflow-wrap: anywhere; }

/* side */
.zt-fxs { display: grid; gap: var(--space-4); }
.zt-fx { display: grid; gap: 4px; padding-top: var(--space-4); border-top: 1px solid var(--line); }
.zt-fx:first-child { padding-top: 0; border-top: 0; }
.zt-fx__d { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.zt-fx__w { font-size: 14px; line-height: 20px; font-weight: 650; }
.zt-fx__m { font-size: 12px; line-height: 17px; color: var(--ink-muted); margin-bottom: 4px; }
.zt-fx__m .code { font-size: 12px; }
.zt-ba { display: grid; grid-template-columns: 52px minmax(0, 1fr) 24px; gap: 10px; align-items: center; font-size: 12px; color: var(--ink-muted); }
.zt-ba b { color: var(--ink); text-align: right; }

@media (max-width: 1200px) {
  .zt-row { grid-template-columns: 18px minmax(0, 1fr) minmax(0, 1.3fr) 120px minmax(0, 1fr); }
  .zt-row > .zt-st, .zt-row > .zt-c { grid-column: 3 / -1; }
  .zt-row--head > :nth-child(n+6) { display: none; }
}
@media (max-width: 760px) {
  .zt-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .zt-row--head { display: none; }
  .zt-row { grid-template-columns: 18px minmax(0, 1fr) auto; gap: 6px 10px; padding: 12px var(--space-4); }
  .zt-row > .zt-m { grid-column: 2 / -1; }
  .zt-row > .zt-tr { grid-column: 2; }
  .zt-row > .zt-n { grid-column: 3; grid-row: 1; text-align: right; }
  .zt-row > .zt-st { grid-column: 3; grid-row: 3; justify-self: end; }
  .zt-row > .zt-c { grid-column: 2 / -1; }
  .zt-foot { padding: var(--space-3) var(--space-4); }
  .zt-cb { grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
  .zt-seg .ic { display: none; }
  .zt-cb__t { display: block; grid-column: 2; margin-top: -4px; font-size: 11px; line-height: 15px; color: var(--ink-muted); }
  .zt-whys { grid-template-columns: minmax(0, 1fr); }
  .zt-why--sum { grid-column: 1; }
  .zt-q__h { grid-template-columns: 40px minmax(0, 1fr); }
  .zt-q__st { grid-column: 2; }
  .zt-said, .zt-q__act, .zt-q .confirm { margin-left: 0; }
  .zt-q .confirm { padding: var(--space-4); }
}

.zt-kpis .card{height:100%}.zt-note{padding:var(--space-4);font-size:14px;line-height:21px;color:var(--ink-muted)}
.zt-coverage{font-size:12px;line-height:18px;margin-top:12px;color:var(--ink-muted)}.zt-coverage b{color:var(--ink)}
.zt-cause-svg{display:block;width:100%;height:28px;min-width:0}.zt-cause-rect{fill:var(--tone)}.zt-cause-label{fill:var(--on-tone);font-size:12px;font-weight:750}
.zt-phone-summary,.zt-phone-causes{display:none}.zt-q__t,.zt-name b,.zt-fx__w,.zt-cb__n b{overflow-wrap:anywhere}
.zt-said span{display:flex;gap:4px;flex-wrap:wrap}.zt-editor{max-width:100%;min-width:0}.zt-editor summary{cursor:pointer}
.zt-editor form{display:grid;gap:10px;margin-top:10px;max-width:100%}.zt-editor textarea{width:100%;box-sizing:border-box}
.zt-ungrouped{display:grid;gap:8px;margin-top:12px}.zt-ungrouped li{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
@media(max-width:1100px){.zt-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.zt-layout{grid-template-columns:minmax(0,1fr)}.zt-row{grid-template-columns:18px minmax(0,1fr) minmax(0,1fr) 120px minmax(0,1fr)}}
@media(max-width:760px){.zt-kpis{grid-template-columns:minmax(0,1fr)}.zt-kpis>section:not(#p-zt-rate){display:none}.zt-phone-summary,.zt-phone-causes{display:block}.zt-desktop-causes{display:none}.zt-layout,.zt-main,.zt-side{display:contents}#p-zt-projects{order:2}#p-zt-causes{order:3}#p-zt-questions{order:4}#p-zt-fixes{order:5}.zt-row{grid-template-columns:18px minmax(0,1fr) auto}.zt-row>.zt-name{grid-column:2/-1}.zt-row>.zt-n{grid-column:2;grid-row:auto;text-align:left}.zt-row>.zt-st{grid-row:auto}.zt-row>.zt-tr{grid-column:2/-1}.zt-q__act{display:grid;gap:12px}.zt-row>.zt-c{grid-column:2/-1}}

.zt-action fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:10px}.zt-action fieldset>.btn{justify-self:start}.zt-action fieldset:disabled{opacity:.65}

.zt-phone-projects{display:none}
@media(max-width:760px){.zt-desktop-projects{display:none}.zt-phone-projects{display:block}.ztp-p__c .zt-tr{font-size:12px}.ztp-p[data-repository]{background:var(--surface-2)}.ztp-p__n b{overflow-wrap:anywhere}.ztp-p__r{max-width:115px}.zt-why small{display:none}.zt-why{padding:8px 0}}

.ztp-qs.zt-phone-questions,.zt-phone-fixes{display:none}.zt-counting{margin-top:10px;font-size:12px;color:var(--ink-muted)}.zt-counting summary{cursor:pointer}.zt-group-link{color:inherit;text-decoration:none}.zt-group-link:hover{text-decoration:underline}
@media(max-width:760px){.zt-desktop-questions,.zt-desktop-fixes{display:none}.ztp-qs.zt-phone-questions,.zt-phone-fixes{display:block}#p-zt-fixes .card__head{display:none}.zt-phone-fixes>summary{display:flex;align-items:start;gap:8px;list-style:none;cursor:pointer;font-size:13px;line-height:20px;color:var(--ink-muted)}.zt-phone-fixes>summary>b,.zt-phone-fixes b{color:var(--ink)}.zt-phone-fixes>summary .ic{flex:none;margin-top:3px}.zt-phone-fixes>summary::-webkit-details-marker{display:none}.zt-fix-observations{padding-top:16px}.ztp-q__a>.zt-editor{width:100%}.ztp-q__a>.zt-editor>summary{display:inline-flex;background:var(--ink);color:var(--canvas);border-radius:999px;padding:6px 12px;font-weight:650;text-decoration:none}.ztp-q__a .zt-action{margin-top:8px}.ztp-q .ztp-q__t small{overflow-wrap:anywhere}.zt-counting{font-size:12px}}

.zt-phone-label{display:none}@media(max-width:760px){.zt-desktop-label{display:none}.zt-phone-label{display:inline}}

/* the phone card */
.zt-w17 { flex: 17 1 0; }
.ztp-now { display: grid; gap: 0; margin-top: var(--space-4); border-top: 1px solid var(--line); }
.ztp-now li { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink-muted); }
.ztp-now li:last-child { border-bottom: 0; padding-bottom: 0; }
.ztp-now li > span:first-child { display: inline-flex; align-items: center; gap: 6px; }
.ztp-now b { color: var(--ink); font-weight: 650; }
.ztp-ps > li { border-top: 1px solid var(--line); }
.ztp-ps > li:first-child { border-top: 0; }
.ztp-p { display: grid; grid-template-columns: minmax(0, 1fr) auto 16px; gap: 4px 10px; align-items: center; padding: 12px var(--space-4); color: inherit; text-decoration: none; }
.ztp-p:hover { background: var(--surface-2); }
.ztp-p__n { display: grid; min-width: 0; }
.ztp-p__n b { font-size: 15px; font-weight: 700; }
.ztp-p__n small { font-size: 12px; color: var(--ink-muted); }
.ztp-p__r { display: grid; justify-items: end; gap: 2px; }
.ztp-p__r b { font-size: 17px; font-weight: 750; font-variant-numeric: tabular-nums; }
.ztp-p__c { grid-column: 1 / 3; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.ztp-p__go { grid-column: 3; grid-row: 1 / 3; color: var(--ink-faint); display: inline-flex; }
.ztp-whys { grid-template-columns: minmax(0, 1fr) !important; margin-top: var(--space-4); }
.ztp-whys .zt-why--sum { grid-column: 1; }
.ztp-qs { display: grid; }
.ztp-q { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 6px 10px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
.ztp-q:first-child { border-top: 0; padding-top: 0; }
.ztp-q .zt-q__n { height: 30px; font-size: 14px; }
.ztp-q__t { display: grid; min-width: 0; }
.ztp-q__t b { font-size: 14px; line-height: 20px; font-weight: 700; }
.ztp-q__t small { font-size: 12px; color: var(--ink-muted); }
.ztp-q__t small .code { font-size: 12px; }
.ztp-q__st, .ztp-q__a { grid-column: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

`;
