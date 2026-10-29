/** Published detail-card rules copied intact from design/tools/gen_fleet2.py, followed by runtime-data adaptations. */

export const HOST_DETAIL_CSS = `
.fl-bar { display: grid; gap: var(--space-4); }
.fl-bar__row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.fl-bar__t { min-width: 0; flex: 1 1 340px; }
.fl-bar__t h2 { font-size: 20px; line-height: 26px; font-weight: 750; }
.fl-bar__t .muted { font-size: 13px; }
.fl-bar__stats { display: flex; gap: 6px; flex-wrap: wrap; }
.fl-bar__stats > span { display: inline-flex; gap: 5px; height: 34px; padding: 0 14px; align-items: center; border-radius: var(--radius-pill); background: var(--surface-2); font-size: 13px; color: var(--ink-muted); }
.fl-bar__stats b { color: var(--ink); font-size: 15px; }
.fl-bar__stats .tinted b { color: var(--tone-ink); }
.fl-bar__btns { display: flex; gap: 8px; flex-wrap: wrap; }
.fl-doc__h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 14px; }
.fl-cnt { display: inline-flex; gap: 12px; font-size: 12px; flex-wrap: wrap; }
.fl-cnt > span { display: inline-flex; align-items: center; gap: 4px; }
.fl-chks { display: grid; gap: 4px; }
.fl-chk { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.fl-chk .code { font-size: 12px; color: var(--ink-muted); }
.fl-chk__said { min-width: 0; }
.fl-chk__fix { grid-column: 1 / -1; color: var(--ink-muted); font-size: 12px; }
.fl-chk__fix b { color: var(--ink); }
.vw .ic { width: 13px; height: 13px; }
.vw--asserted { background: var(--surface-2); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.vw--absent { background: transparent; color: var(--ink-muted); box-shadow: none; border: 1px dashed var(--line); }
.lead-s { font-size: 13px; line-height: 20px; color: var(--ink-muted); max-width: 820px; }
.mini-list { display: grid; gap: 6px; font-size: 13px; }
.mini-list li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
.mini-list li > .ic { margin-top: 2px; color: var(--tone-ink, var(--ink-muted)); }
.mini-list small { display: block; color: var(--ink-muted); font-size: 12px; line-height: 17px; }
.sect-h { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin: var(--space-4) 0 var(--space-2); }
.sect-h:first-child { margin-top: 0; }
.pp-pad { padding: 0 var(--space-5) var(--space-5); }
.pp-pad .confirm { margin-top: var(--space-3); }
@media (max-width: 760px) {
  .pp-pad { padding: 0 var(--space-4) var(--space-4); }
  .fl-bar__t { flex-basis: 100%; }
  .fl-chk { grid-template-columns: auto minmax(0, 1fr); }
  .fl-chk__said { grid-column: 1 / -1; }
}

.hd-state { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-4); align-items: center; }
.hd-state .tile { background: var(--surface); color: var(--tone-ink); }
.hd-state__t h2 { font-size: 18px; line-height: 24px; font-weight: 750; color: var(--tone-ink); }
.hd-state__t p { font-size: 13px; line-height: 20px; margin-top: 2px; }
.hd-slots { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: var(--space-4); font-size: 13px; }
.hd-sls .sl { width: 22px; height: 22px; }
.hd-bud { display: grid; grid-template-columns: 64px minmax(0, 1fr) 112px; gap: 10px; align-items: center; margin-bottom: 10px; font-size: 13px; }
.hd-bud__l { color: var(--ink-muted); }
.hd-bud__bar { width: 100%; display: block; }
.hd-bud__v { text-align: right; white-space: nowrap; color: var(--ink-muted); }
.hd-bud__v b { color: var(--ink); }
.hd-bed { fill: var(--surface-3); }
.hd-used { fill: var(--running); }
.hd-held { stroke: var(--attention); stroke-width: 1; }
.hd-sep { stroke: var(--surface); stroke-width: 2; }
.hd-key { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 0 var(--space-4); font-size: 12px; color: var(--ink-muted); }
.hd-key > span { display: inline-flex; align-items: center; gap: 6px; }
.hd-k { display: inline-block; width: 14px; height: 10px; border-radius: 3px; background: var(--surface-3); }
.hd-k--used, .hd-k--bar { background: var(--running); }
.hd-k--held { background: var(--attention-tint); box-shadow: inset 0 0 0 1px var(--attention); }
.hd-k--peak { height: 2px; background: var(--ink); border-radius: 1px; }
.hd-k--slot { height: 0; border-top: 2px dashed var(--ink-muted); background: transparent; border-radius: 0; }
.hd-k--nd { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-strong); }
.tbl .hd-nw { white-space: nowrap; }
.hd-words { display: grid; gap: 6px; font-size: 12px; line-height: 17px; }
.hd-words li { padding: 8px 12px; border-radius: 12px; background: var(--surface-2); color: var(--ink-muted); }
.hd-words b { color: var(--ink); font-weight: 650; margin-right: 4px; }
.hd-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: var(--space-4); }
.hd-kpis > div { display: grid; gap: 2px; padding: 10px 12px; border-radius: 14px; background: var(--surface-2); }
.hd-kpis b { font-size: 22px; line-height: 26px; font-weight: 800; font-variant-numeric: tabular-nums; }
.hd-kpis span { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.hd-chart { display: block; width: 100%; }
.hd-bar { fill: var(--running); }
.hd-peak { stroke: var(--ink); stroke-width: 2; }
.hd-slotline { stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.hd-axis { stroke: var(--line-strong); stroke-width: 1; }
.hd-tick { fill: var(--ink-muted); font-size: 11px; }
.hd-nd-bg { fill: var(--surface-2); }
.hd-nd-ln { fill: var(--line); }
.hd-cav { margin: var(--space-3) 0; }
.hd-fp { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.hd-docline { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; line-height: 20px; margin-bottom: var(--space-3); }
.hd-docline .ic { margin-top: 3px; flex: none; }
.hd-docline span { color: var(--ink); }
.hd-secs { display: flex; flex-wrap: wrap; gap: 4px; }
.hd-sec { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px 0 7px; border-radius: var(--radius-pill); background: var(--surface-2); color: var(--ink-muted); font-size: 12px; font-weight: 600; }
.hd-sec .ic { width: 12px; height: 12px; color: var(--ok-ink); }
.hd-sec.tone-failed { background: var(--failed-tint); color: var(--failed-ink); }
.hd-sec.tone-failed .ic { color: var(--failed-ink); }
.hd-sec b { font-weight: 800; }
.hd-seckey { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12px; color: var(--ink-muted); }
.hd-seckey > span { display: inline-flex; align-items: center; gap: 5px; }
.hd-seckey .ic { width: 12px; height: 12px; }
.hd-sec--off { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.hd-sec--off .ic { color: var(--ink-muted); }
.card .fl-chks + .cmd { margin-top: var(--space-3); }
@media (max-width: 760px) {
  .tbl--stack tr.row--attention { background: var(--attention-tint); }
  .hd-state { grid-template-columns: auto minmax(0, 1fr); }
  .hd-state__a { grid-column: 1 / -1; }
  .hd-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hd-bud { grid-template-columns: 56px minmax(0, 1fr) auto; }
}

/* Runtime data may exceed the sample's image spelling; preserve the published card above. */
.hd-image { white-space: normal; overflow-wrap: anywhere; }
.hd-sec.tone-attention { background: var(--attention-tint); color: var(--attention-ink); }
.hd-sec.tone-attention .ic { color: var(--attention-ink); }
@media (max-width: 760px) { .hd-chart .hd-tick { font-size: 20px; } }
`;

export const VENUE_DETAIL_CSS = `
.fl-bar { display: grid; gap: var(--space-4); }
.fl-bar__row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.fl-bar__t { min-width: 0; flex: 1 1 340px; }
.fl-bar__t h2 { font-size: 20px; line-height: 26px; font-weight: 750; }
.fl-bar__t .muted { font-size: 13px; }
.fl-bar__stats { display: flex; gap: 6px; flex-wrap: wrap; }
.fl-bar__stats > span { display: inline-flex; gap: 5px; height: 34px; padding: 0 14px; align-items: center; border-radius: var(--radius-pill); background: var(--surface-2); font-size: 13px; color: var(--ink-muted); }
.fl-bar__stats b { color: var(--ink); font-size: 15px; }
.fl-bar__stats .tinted b { color: var(--tone-ink); }
.fl-bar__btns { display: flex; gap: 8px; flex-wrap: wrap; }
.fl-doc__h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 14px; }
.fl-cnt { display: inline-flex; gap: 12px; font-size: 12px; flex-wrap: wrap; }
.fl-cnt > span { display: inline-flex; align-items: center; gap: 4px; }
.fl-chks { display: grid; gap: 4px; }
.fl-chk { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.fl-chk .code { font-size: 12px; color: var(--ink-muted); }
.fl-chk__said { min-width: 0; }
.fl-chk__fix { grid-column: 1 / -1; color: var(--ink-muted); font-size: 12px; }
.fl-chk__fix b { color: var(--ink); }
.vw .ic { width: 13px; height: 13px; }
.vw--asserted { background: var(--surface-2); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.vw--absent { background: transparent; color: var(--ink-muted); box-shadow: none; border: 1px dashed var(--line); }
.lead-s { font-size: 13px; line-height: 20px; color: var(--ink-muted); max-width: 820px; }
.mini-list { display: grid; gap: 6px; font-size: 13px; }
.mini-list li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
.mini-list li > .ic { margin-top: 2px; color: var(--tone-ink, var(--ink-muted)); }
.mini-list small { display: block; color: var(--ink-muted); font-size: 12px; line-height: 17px; }
.sect-h { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin: var(--space-4) 0 var(--space-2); }
.sect-h:first-child { margin-top: 0; }
.pp-pad { padding: 0 var(--space-5) var(--space-5); }
.pp-pad .confirm { margin-top: var(--space-3); }
@media (max-width: 760px) {
  .pp-pad { padding: 0 var(--space-4) var(--space-4); }
  .fl-bar__t { flex-basis: 100%; }
  .fl-chk { grid-template-columns: auto minmax(0, 1fr); }
  .fl-chk__said { grid-column: 1 / -1; }
}

.vd-key { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.vd-key .ic { flex: none; }
.vd-intro { font-size: 13px; line-height: 20px; color: var(--ink-muted); max-width: 900px; }
.vd-seg { flex-wrap: wrap; height: auto; max-width: 100%; }
.vd-serves { display: grid; gap: 6px; }
.vd-serves li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.vd-serves__n { font-weight: 650; }
.vd-serves__t { grid-column: 1 / -1; color: var(--ink-muted); font-size: 12px; line-height: 17px; }
.vd-decl { display: grid; gap: 6px; padding: 0 var(--space-5) var(--space-4); font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.vd-decl li { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 10px; align-items: center; }
.vd-note { margin-top: var(--space-3); font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.vd-gw { display: inline-flex; gap: 6px; align-items: flex-start; font-size: 13px; }
.vd-gw .ic { color: var(--tone-ink); margin-top: 2px; flex: none; }
.vd-gws { display: grid; gap: 6px; }
.vd-tbl td { vertical-align: top; }
.vd-tbl .vd-p { min-width: 260px; max-width: 360px; white-space: normal; }
.vd-p .reason { max-width: 360px; }
.vd-key { display: block; margin-top: 4px; }
.vd-key .code { font-size: 11px; color: var(--ink-muted); }
.vd-mean { display: block; max-width: 520px; font-size: 13px; line-height: 19px; }
.vd-by { display: block; margin-top: 4px; color: var(--ink-muted); font-size: 12px; line-height: 17px; }
.vd-floorl { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; padding: 6px 10px; border-radius: 10px; background: var(--attention-tint); color: var(--ink); font-size: 12px; line-height: 17px; }
.vd-floorl .ic { color: var(--attention-ink); margin-top: 1px; flex: none; }
.vd-fixl { margin: var(--space-3) 0 var(--space-2); font-size: 13px; line-height: 19px; }
.vd-cmp th.vd-c, .vd-cmp td.vd-c { text-align: center; }
.vd-cmp .vd-cur { background: var(--surface-2); }
.vd-cmp tbody tr:hover td.vd-cur { background: var(--surface-3); }
.vd-cmp .vd-p { white-space: nowrap; font-weight: 600; }
.vd-cmp th:first-child, .vd-cmp td.vd-p { position: sticky; left: 0; z-index: 1; background: var(--surface); }
.vd-cmp tbody tr:hover td.vd-p { background: var(--surface-2); }
.vd-split td { padding-top: 18px; border-bottom-color: var(--line-strong); }
.vd-legend { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; padding: var(--space-3) var(--space-5) var(--space-4); border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-muted); }
.vd-legend > span { display: inline-flex; align-items: center; gap: 6px; }
@media (max-width: 760px) {
  .vd-decl { padding: 0 var(--space-4) var(--space-3); }
  .vd-decl li { grid-template-columns: minmax(0, 1fr); gap: 4px; justify-items: start; }
  .vd-tbl .vd-p { min-width: 0; max-width: none; }
  .vd-tbl .vd-mean { margin-top: 6px; }
  .vd-cmp .vd-p { white-space: normal; min-width: 150px; max-width: 150px; box-shadow: 1px 0 0 var(--line); }
  .vd-legend { padding: var(--space-3) var(--space-4); }
}

.titlebar__end .seg{flex-wrap:wrap;height:auto;max-width:100%}

/* The declaration is one component, not three separately labelled mobile facts. */
@media (max-width: 760px) {
  .vd-tbl .tbl--stack tr { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 10px; }
  .vd-tbl .tbl--stack td[data-l]::before { content: none; }
  .vd-tbl .tbl--stack td:nth-child(1) { grid-column: 1; grid-row: 1; min-width: 0; }
  .vd-tbl .tbl--stack td:nth-child(2) { grid-column: 2; grid-row: 1; justify-self: end; align-self: start; }
  .vd-tbl .tbl--stack td:nth-child(3) { grid-column: 1 / -1; grid-row: 2; }
}
`;
