/** Page-local rules copied from the six Spend design cards, plus responsive adapters for real data. */
import { PAGE_THEME } from "../graph-html.mjs";

const PD_TOKENS = Object.freeze({
  canvas: "canvas",
  panel: "surface",
  border: "line",
  fg: "ink",
  dim: "ink-muted",
  accent: "focus",
  amber: "attention-ink",
  danger: "failed-ink",
  green: "ok-ink",
  chipStroke: "line-strong",
  bannerBg: "failed-tint",
  control: "surface-3",
});
const SVG_EXTRA = Object.freeze({
  "#333": ["ink", "ink"],
  "#d9d9d9": ["surface", "line-strong"],
  "#a6bbcf": ["surface-3", "ink-faint"],
  "#d8bfd8": ["surface-3", "line-strong"],
  "#e7e7ae": ["surface-3", "line-strong"],
  "#c0deed": ["surface-3", "line-strong"],
  "#c7e9c0": ["surface-3", "line-strong"],
  "#fdd0a2": ["surface-3", "line-strong"],
  "#E6E0F8": ["ink-faint", "ink-faint"],
  "#ff5f57": ["failed", "failed"],
  "#6e7681": ["idle", "ink-muted"],
  "#db6d28": ["attention", "attention"],
});
export const SPEND_CARD_CSS_HASHES = Object.freeze({
  SpendScreen:
    "291325e558c242ea00657f4d86030df75df56b0ebe354b1781ac76e4919f7e7e",
  SpendBudgetSplit:
    "ddf361395b51f2868de87ed1200f3bb4681c6339fdf8e06f29e9d4f75bc5392c",
  SpendCapacity:
    "ddf361395b51f2868de87ed1200f3bb4681c6339fdf8e06f29e9d4f75bc5392c",
  SpendBreakdown:
    "ddf361395b51f2868de87ed1200f3bb4681c6339fdf8e06f29e9d4f75bc5392c",
  TopologyScreen:
    "ddf361395b51f2868de87ed1200f3bb4681c6339fdf8e06f29e9d4f75bc5392c",
  SpendPhone:
    "291325e558c242ea00657f4d86030df75df56b0ebe354b1781ac76e4919f7e7e",
});
export const SPEND_DESIGN_CSS = String.raw`
.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.sp-tabs { margin: var(--space-2) 0 var(--space-4); }
.sp-tabs a .ic { opacity: .8; }
.sp-kf { margin-top: 10px; font-size: 12px; color: var(--ink-muted); }
.sp-kf b { color: var(--ink); }
.sp-chart, .sp-hist, .sp-split { display: block; width: 100%; overflow: visible; }
.sp-bar { fill: var(--ok); }
.sp-held { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.sp-cap { stroke: var(--failed); stroke-width: 1.5; stroke-dasharray: 2 4; }
.sp-hold { stroke: var(--ink-faint); stroke-width: 1.5; stroke-dasharray: 5 4; }
.sp-base { stroke: var(--line); }
.sp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.sp-ll--cap { fill: var(--ink-muted); }
.sp-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-d { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.sp-d--now { fill: var(--ink); font-weight: 750; }
.sp-gap { font-size: 14px; font-weight: 700; fill: var(--ink-faint); }
.sp-hbin { fill: var(--ink-muted); }
.sp-capline { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 3 3; }
.sp-k { display: inline-block; width: 14px; height: 10px; border-radius: 4px; }
.sp-k--bar { background: var(--ok); }
.sp-k--held { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.sp-k--hold { height: 0; border-top: 2px dashed var(--ink-faint); border-radius: 0; }
.sp-hbars { display: grid; gap: 14px; }
.sp-hb { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-hb__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.sp-hb__l small { font-size: 11px; color: var(--ink-muted); }
.sp-hb__bar { display: block; width: 100%; }
.sp-hb__bed { fill: var(--dot-off); }
.sp-hb__fill { fill: var(--ink-muted); }
.sp-hb__v { text-align: right; white-space: nowrap; font-size: 13px; }
.sp-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sp-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sp-note--ic .ic { margin-top: 1px; }
.sp-note b { color: var(--ink); }
.sp-note--wide { margin: 0 4px; }
.sp-caps { display: grid; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; border-bottom: 1px solid var(--line); }
.sp-wiform { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.sp-wi__s { margin: var(--space-4) 0 var(--space-3); font-size: 15px; line-height: 22px; }
.sp-wi { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-wi__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; font-weight: 650; margin-top: 6px; }
.sp-wi__l small { font-weight: 500; font-size: 11px; color: var(--ink-muted); }
.sp-wi b { text-align: right; white-space: nowrap; }
.sp-mp { display: grid; gap: 6px; }
.sp-mp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sp-mp__t { display: flex; flex-direction: column; min-width: 0; }
.sp-mp__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.sp-mp__v { white-space: nowrap; }
.sp-mp__k { min-width: 64px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.sp-seg--0 { fill: var(--surface-3); } .sp-seg--1 { fill: var(--dot-off); }
.sp-seg { stroke: var(--surface); stroke-width: 3; }
.sp-seg__t { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-rows { display: grid; margin-top: 6px; }
.sp-rows .meterrow { grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .sp-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-3); }
  .sp-range { width: 100%; justify-content: space-between; }
  .sp-wiform { grid-template-columns: minmax(0, 1fr); }
  .sp-chart .sp-v { font-size: 10px; }
  .sp-chart .sp-d { font-size: 10px; }
  .sp-caps .meterrow, .sp-rows .meterrow { grid-template-columns: minmax(0, 104px) minmax(0, 1fr) auto; }
}


.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.sp-tabs { margin: var(--space-2) 0 var(--space-4); }
.sp-tabs a .ic { opacity: .8; }
.sp-kf { margin-top: 10px; font-size: 12px; color: var(--ink-muted); }
.sp-kf b { color: var(--ink); }
.sp-chart, .sp-hist, .sp-split { display: block; width: 100%; overflow: visible; }
.sp-bar { fill: var(--ok); }
.sp-held { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.sp-cap { stroke: var(--failed); stroke-width: 1.5; stroke-dasharray: 2 4; }
.sp-hold { stroke: var(--ink-faint); stroke-width: 1.5; stroke-dasharray: 5 4; }
.sp-base { stroke: var(--line); }
.sp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.sp-ll--cap { fill: var(--ink-muted); }
.sp-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-d { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.sp-d--now { fill: var(--ink); font-weight: 750; }
.sp-gap { font-size: 14px; font-weight: 700; fill: var(--ink-faint); }
.sp-hbin { fill: var(--ink-muted); }
.sp-capline { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 3 3; }
.sp-k { display: inline-block; width: 14px; height: 10px; border-radius: 4px; }
.sp-k--bar { background: var(--ok); }
.sp-k--held { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.sp-k--hold { height: 0; border-top: 2px dashed var(--ink-faint); border-radius: 0; }
.sp-hbars { display: grid; gap: 14px; }
.sp-hb { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-hb__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.sp-hb__l small { font-size: 11px; color: var(--ink-muted); }
.sp-hb__bar { display: block; width: 100%; }
.sp-hb__bed { fill: var(--dot-off); }
.sp-hb__fill { fill: var(--ink-muted); }
.sp-hb__v { text-align: right; white-space: nowrap; font-size: 13px; }
.sp-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sp-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sp-note--ic .ic { margin-top: 1px; }
.sp-note b { color: var(--ink); }
.sp-note--wide { margin: 0 4px; }
.sp-caps { display: grid; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; border-bottom: 1px solid var(--line); }
.sp-wiform { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.sp-wi__s { margin: var(--space-4) 0 var(--space-3); font-size: 15px; line-height: 22px; }
.sp-wi { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-wi__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; font-weight: 650; margin-top: 6px; }
.sp-wi__l small { font-weight: 500; font-size: 11px; color: var(--ink-muted); }
.sp-wi b { text-align: right; white-space: nowrap; }
.sp-mp { display: grid; gap: 6px; }
.sp-mp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sp-mp__t { display: flex; flex-direction: column; min-width: 0; }
.sp-mp__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.sp-mp__v { white-space: nowrap; }
.sp-mp__k { min-width: 64px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.sp-seg--0 { fill: var(--surface-3); } .sp-seg--1 { fill: var(--dot-off); }
.sp-seg { stroke: var(--surface); stroke-width: 3; }
.sp-seg__t { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-rows { display: grid; margin-top: 6px; }
.sp-rows .meterrow { grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .sp-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-3); }
  .sp-range { width: 100%; justify-content: space-between; }
  .sp-wiform { grid-template-columns: minmax(0, 1fr); }
  .sp-chart .sp-v { font-size: 10px; }
  .sp-chart .sp-d { font-size: 10px; }
  .sp-caps .meterrow, .sp-rows .meterrow { grid-template-columns: minmax(0, 104px) minmax(0, 1fr) auto; }
}

.sx-win { display: flex; align-items: center; gap: 6px; margin: -6px 4px 0; font-size: 12px; color: var(--ink-muted); }
.sx-k { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-k b { color: var(--ink); }
.sx-lead { margin: 0 4px; font-size: 13px; line-height: 19px; color: var(--ink-muted); max-width: 980px; }
.sx-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-note b { color: var(--ink); }
.sx-note--top { margin: 0 0 var(--space-3); }
.sx-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sx-note--ic .ic { margin-top: 1px; flex: none; }
.sx-note.tone-attention { color: var(--attention-ink); font-weight: 600; }
.sx-pad { padding: 0 var(--space-5); }
.sx-pad--b { padding-bottom: var(--space-5); }
.sx-lines { display: grid; gap: 8px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.sx-lines li { padding-left: 14px; position: relative; }
.sx-lines li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--ink-faint); }
.sx-lines b { color: var(--ink); }
.sx-states { display: grid; gap: 8px; }

/* budget split */
.al-env { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: var(--space-4); font-size: 15px; }
.al-env__h { margin-left: auto; font-size: 13px; color: var(--ink-muted); }
.al-env__h b { color: var(--ink); }
.al-rows { display: grid; gap: 4px; margin-top: var(--space-4); }
.al-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.al-row:last-child { border-bottom: 0; }
.al-row__l { display: flex; align-items: center; gap: 8px; }
.al-row__l small, .al-row__v small { font-size: 11px; color: var(--ink-muted); }
.al-row__v { display: flex; flex-direction: column; align-items: flex-end; font-size: 13px; color: var(--ink-muted); white-space: nowrap; }
.al-row__v b { color: var(--ink); }
.al-bar { display: block; width: 100%; overflow: visible; }
.al-bar__track { fill: var(--surface-2); }
.al-bar__alloc { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; }
.al-bar__spent { fill: var(--ok); }
.al-bar__spent--over { fill: var(--failed); }
.al-bar__floor { stroke: var(--attention); stroke-width: 3; stroke-linecap: round; }
.al-k { display: inline-block; width: 18px; height: 10px; border-radius: 5px; }
.al-k--alloc { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.al-k--spent { background: var(--ok); }
.al-k--floor { width: 3px; height: 14px; border-radius: 2px; background: var(--attention); }
.al-k--over { background: var(--failed); }
.al-sel td { background: var(--surface-2); }
.pr-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.pr-row { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.pr-row .ptag { justify-self: start; }
.pr-in { width: 100%; max-width: 120px; }
.pr-share { font-size: 12px; color: var(--ink-muted); }
.pr-foot { margin-top: var(--space-4); align-items: flex-end; }
.cn-h { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; margin: 4px 0 8px; }
.cn-h + .cn-l + .cn-h { margin-top: var(--space-4); }
.cn-l { display: grid; gap: 4px; }
.cn-l li { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.rs-l { display: grid; gap: 8px; }
.rs-l li { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.rs-l .ptag { justify-self: start; }
.rs-l q { font-size: 13px; line-height: 19px; color: var(--ink); quotes: "\201C" "\201D"; }

/* capacity */
.cp-trio { display: flex; gap: var(--space-5); margin: -6px 0 var(--space-3); }
.cp-trio span { display: flex; align-items: baseline; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.cp-trio b { font-size: 28px; line-height: 32px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
.cp-trio__0 b { color: var(--ink-faint); }
.cp-chart { display: block; width: 100%; overflow: visible; margin-bottom: var(--space-4); }
.cp-bar { fill: var(--running); }
.cp-peak { fill: var(--ink); }
.cp-slots { stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.cp-base { stroke: var(--line-strong); }
.cp-grid { stroke: var(--line); }
.cp-now { stroke: var(--ink); stroke-width: 1.5; }
.cp-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.cp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.cp-ll--now { fill: var(--ink); }
.cp-nd-bg { fill: var(--surface-2); }
.cp-nd-ln { fill: var(--line-strong); opacity: .55; }
.cp-key { display: grid; gap: 10px; }
.cp-proj { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.cp-proj > span { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
.cp-key li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-muted); }
.cp-key li b { color: var(--ink); margin-right: 4px; }
.cp-key svg { flex: none; overflow: visible; }

/* breakdown */
.bk-chart, .bk-cum, .bk-mchart { display: block; width: 100%; overflow: visible; }
.bk-bar { fill: var(--ok); }
.bk-est { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-floor { stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; }
.bk-zero { fill: var(--ink-faint); }
.bk-grid { stroke: var(--line); }
.bk-base { stroke: var(--line-strong); }
.bk-ax { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.bk-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.bk-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.bk-d--now { fill: var(--ink); font-weight: 750; }
.bk-cl { stroke: var(--ink-muted); stroke-width: 2; }
.bk-cl--est { stroke-dasharray: 5 4; }
.bk-cd { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 2; }
.bk-cum { margin-top: var(--space-2); }
.bk-k { display: inline-block; width: 16px; height: 10px; border-radius: 4px; }
.bk-k--bar { background: var(--ok); }
.bk-k--est { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.bk-k--floor { height: 3px; background: var(--ink); }
.bk-k--zero { height: 2px; background: var(--ink-faint); }
.bk-mult { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.bk-mf { padding: 12px 12px 6px; border-radius: var(--radius-md); background: var(--surface-2); }
.bk-mf figcaption { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.bk-mf figcaption span { font-weight: 700; }
.bk-sm { fill: var(--ink-muted); }
.bk-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.bk-h { font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.bk-h--2 { margin-top: var(--space-5); }
.bk-rows { display: grid; gap: 12px; }
.bk-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; align-items: center; font-size: 13px; }
.bk-row__l { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.bk-row__l small { font-size: 11px; color: var(--ink-muted); }
.bk-row__v { text-align: right; white-space: nowrap; }
.bk-hb { display: block; width: 100%; }
.bk-hb__bed { fill: var(--dot-off); }
.bk-hb__fill { fill: var(--ink-muted); }
.bk-hb__api { fill: none; stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-hb__zero { stroke: var(--ink); stroke-width: 2; }
.bk-tail { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1.5px var(--line-strong); color: var(--ink-muted); }
.pl { padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.pl + .pl { margin-top: 8px; }
.pl__h { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.pl__h > div { flex: 1; min-width: 0; }
.pl__t { font-size: 15px; font-weight: 700; }
.pl .facts { gap: 8px; }
.lg-l { display: grid; gap: 8px; }
.lg-l li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; color: var(--ink-muted); }
.lg-l li b { color: var(--ink); }
.lg-m { font-weight: 750; color: var(--ink); font-variant-numeric: tabular-nums; }
.wf-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: end; }
.wf-form .field:first-child { grid-column: 1 / -1; }
.wf-ans { margin-top: var(--space-4); padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.wf-ans__h { font-size: 13px; color: var(--ink-muted); }
.wf-ans__n { margin: 4px 0 10px; font-size: 18px; line-height: 26px; }
.wf-other { display: grid; gap: 8px; margin-top: var(--space-4); }
.wf-other__h { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.wf-o { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; }
.wf-o__s { margin-top: 2px; font-size: 12px; color: var(--ink-muted); }

/* flows map */
.fm-wrap { overflow-x: auto; border-radius: var(--radius-md); background: var(--canvas); }
.fm-svg { display: block; width: 100%; height: auto; }
.fm-zoom { display: flex; gap: 6px; }
.fm-zoom .roundbtn { width: 38px; height: 38px; background: var(--surface-2); }
.fm-g__b { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.fm-g__t { font-size: 14px; font-weight: 750; fill: var(--ink); }
.fm-g__s { font-size: 11px; font-weight: 500; fill: var(--ink-muted); }
.fm-trig__b { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.fm-flow__b { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 1.5; }
.fm-flow--unv .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--line-strong); }
.fm-flow--head .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--attention); }
.fm-flow--miss .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--failed); }
.fm-flow--orphan { opacity: .55; }
.fm-flow--orphan .fm-flow__b { stroke-dasharray: 2 4; }
.fm-trig--spent .fm-trig__b { stroke-dasharray: 2 4; fill: var(--surface); }
.fm-ic { color: var(--ink-muted); }
.fm-t { font-size: 14px; font-weight: 700; fill: var(--ink); }
.fm-s { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.fm-e path { fill: none; stroke: var(--ink-faint); stroke-width: 1.6; }
.fm-e--observed path { stroke: var(--ink-muted); stroke-width: 3.5; }
.fm-e--potential path { stroke-dasharray: 6 5; }
.fm-e--rearm path { stroke-dasharray: 3 4; }
.fm-el { font-size: 11px; font-weight: 650; fill: var(--ink-muted); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.fm-e .arrowhead, .fm-sw .arrowhead { fill: var(--ink-faint); }
.fm-bd--risk { fill: var(--refused); stroke: var(--surface); stroke-width: 2; }
.fm-bd--chain { fill: var(--surface); stroke: var(--ok); stroke-width: 3; }
.fm-n:focus-visible { outline: none; }
.fm-n:focus-visible rect:first-child { stroke: var(--focus); stroke-width: 3; }
.is-dim { opacity: .45; }
.is-sel .fm-trig__b { fill: var(--primary); stroke: var(--primary); }
.is-sel .fm-t { fill: var(--on-primary); }
.is-sel .fm-ic { color: var(--on-primary); }
.is-sel.fm-e path { stroke: var(--ink); stroke-width: 2.2; }
.is-near .fm-flow__b { stroke: var(--ink); stroke-width: 2.5; }
.fm-lgs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-5); }
.fm-lg__h { font-size: 12px; font-weight: 700; color: var(--ink-muted); margin-bottom: 8px; }
.fm-lg__h--gap { margin-top: var(--space-4); }
.fm-lg ul { display: grid; gap: 8px; }
.fm-lg li { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.fm-lg li b { color: var(--ink); margin-right: 3px; }
.fm-sw { flex: none; overflow: visible; }
.fm-caps { margin: var(--space-4) 0; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; font-weight: 600; }
.fm-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--space-4); }
.fm-selcard { box-shadow: inset 0 0 0 2px var(--primary); }

@media (max-width: 760px) {
  .al-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
  .al-row .al-bar { grid-column: 1 / -1; grid-row: 2; }
  .al-env__h { margin-left: 0; }
  .pr-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sx-pad { padding: 0 var(--space-4); } .sx-pad--b { padding-bottom: var(--space-4); }
  .cp-trio { gap: var(--space-4); }
  .cp-trio b { font-size: 22px; line-height: 26px; }
  .cp-d { font-size: 9px; }
  .bk-mult { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bk-cols { grid-template-columns: minmax(0, 1fr); gap: var(--space-5); }
  .bk-chart .bk-v { font-size: 10px; }
  .bk-chart .bk-d { font-size: 10px; }
  .wf-form { grid-template-columns: minmax(0, 1fr); }
  .fm-svg { min-width: 820px; }
  .fm-lgs { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .lg-l li { grid-template-columns: 84px minmax(0, 1fr); }
}


.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.sp-tabs { margin: var(--space-2) 0 var(--space-4); }
.sp-tabs a .ic { opacity: .8; }
.sp-kf { margin-top: 10px; font-size: 12px; color: var(--ink-muted); }
.sp-kf b { color: var(--ink); }
.sp-chart, .sp-hist, .sp-split { display: block; width: 100%; overflow: visible; }
.sp-bar { fill: var(--ok); }
.sp-held { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.sp-cap { stroke: var(--failed); stroke-width: 1.5; stroke-dasharray: 2 4; }
.sp-hold { stroke: var(--ink-faint); stroke-width: 1.5; stroke-dasharray: 5 4; }
.sp-base { stroke: var(--line); }
.sp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.sp-ll--cap { fill: var(--ink-muted); }
.sp-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-d { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.sp-d--now { fill: var(--ink); font-weight: 750; }
.sp-gap { font-size: 14px; font-weight: 700; fill: var(--ink-faint); }
.sp-hbin { fill: var(--ink-muted); }
.sp-capline { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 3 3; }
.sp-k { display: inline-block; width: 14px; height: 10px; border-radius: 4px; }
.sp-k--bar { background: var(--ok); }
.sp-k--held { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.sp-k--hold { height: 0; border-top: 2px dashed var(--ink-faint); border-radius: 0; }
.sp-hbars { display: grid; gap: 14px; }
.sp-hb { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-hb__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.sp-hb__l small { font-size: 11px; color: var(--ink-muted); }
.sp-hb__bar { display: block; width: 100%; }
.sp-hb__bed { fill: var(--dot-off); }
.sp-hb__fill { fill: var(--ink-muted); }
.sp-hb__v { text-align: right; white-space: nowrap; font-size: 13px; }
.sp-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sp-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sp-note--ic .ic { margin-top: 1px; }
.sp-note b { color: var(--ink); }
.sp-note--wide { margin: 0 4px; }
.sp-caps { display: grid; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; border-bottom: 1px solid var(--line); }
.sp-wiform { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.sp-wi__s { margin: var(--space-4) 0 var(--space-3); font-size: 15px; line-height: 22px; }
.sp-wi { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-wi__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; font-weight: 650; margin-top: 6px; }
.sp-wi__l small { font-weight: 500; font-size: 11px; color: var(--ink-muted); }
.sp-wi b { text-align: right; white-space: nowrap; }
.sp-mp { display: grid; gap: 6px; }
.sp-mp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sp-mp__t { display: flex; flex-direction: column; min-width: 0; }
.sp-mp__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.sp-mp__v { white-space: nowrap; }
.sp-mp__k { min-width: 64px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.sp-seg--0 { fill: var(--surface-3); } .sp-seg--1 { fill: var(--dot-off); }
.sp-seg { stroke: var(--surface); stroke-width: 3; }
.sp-seg__t { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-rows { display: grid; margin-top: 6px; }
.sp-rows .meterrow { grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .sp-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-3); }
  .sp-range { width: 100%; justify-content: space-between; }
  .sp-wiform { grid-template-columns: minmax(0, 1fr); }
  .sp-chart .sp-v { font-size: 10px; }
  .sp-chart .sp-d { font-size: 10px; }
  .sp-caps .meterrow, .sp-rows .meterrow { grid-template-columns: minmax(0, 104px) minmax(0, 1fr) auto; }
}

.sx-win { display: flex; align-items: center; gap: 6px; margin: -6px 4px 0; font-size: 12px; color: var(--ink-muted); }
.sx-k { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-k b { color: var(--ink); }
.sx-lead { margin: 0 4px; font-size: 13px; line-height: 19px; color: var(--ink-muted); max-width: 980px; }
.sx-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-note b { color: var(--ink); }
.sx-note--top { margin: 0 0 var(--space-3); }
.sx-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sx-note--ic .ic { margin-top: 1px; flex: none; }
.sx-note.tone-attention { color: var(--attention-ink); font-weight: 600; }
.sx-pad { padding: 0 var(--space-5); }
.sx-pad--b { padding-bottom: var(--space-5); }
.sx-lines { display: grid; gap: 8px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.sx-lines li { padding-left: 14px; position: relative; }
.sx-lines li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--ink-faint); }
.sx-lines b { color: var(--ink); }
.sx-states { display: grid; gap: 8px; }

/* budget split */
.al-env { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: var(--space-4); font-size: 15px; }
.al-env__h { margin-left: auto; font-size: 13px; color: var(--ink-muted); }
.al-env__h b { color: var(--ink); }
.al-rows { display: grid; gap: 4px; margin-top: var(--space-4); }
.al-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.al-row:last-child { border-bottom: 0; }
.al-row__l { display: flex; align-items: center; gap: 8px; }
.al-row__l small, .al-row__v small { font-size: 11px; color: var(--ink-muted); }
.al-row__v { display: flex; flex-direction: column; align-items: flex-end; font-size: 13px; color: var(--ink-muted); white-space: nowrap; }
.al-row__v b { color: var(--ink); }
.al-bar { display: block; width: 100%; overflow: visible; }
.al-bar__track { fill: var(--surface-2); }
.al-bar__alloc { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; }
.al-bar__spent { fill: var(--ok); }
.al-bar__spent--over { fill: var(--failed); }
.al-bar__floor { stroke: var(--attention); stroke-width: 3; stroke-linecap: round; }
.al-k { display: inline-block; width: 18px; height: 10px; border-radius: 5px; }
.al-k--alloc { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.al-k--spent { background: var(--ok); }
.al-k--floor { width: 3px; height: 14px; border-radius: 2px; background: var(--attention); }
.al-k--over { background: var(--failed); }
.al-sel td { background: var(--surface-2); }
.pr-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.pr-row { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.pr-row .ptag { justify-self: start; }
.pr-in { width: 100%; max-width: 120px; }
.pr-share { font-size: 12px; color: var(--ink-muted); }
.pr-foot { margin-top: var(--space-4); align-items: flex-end; }
.cn-h { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; margin: 4px 0 8px; }
.cn-h + .cn-l + .cn-h { margin-top: var(--space-4); }
.cn-l { display: grid; gap: 4px; }
.cn-l li { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.rs-l { display: grid; gap: 8px; }
.rs-l li { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.rs-l .ptag { justify-self: start; }
.rs-l q { font-size: 13px; line-height: 19px; color: var(--ink); quotes: "\201C" "\201D"; }

/* capacity */
.cp-trio { display: flex; gap: var(--space-5); margin: -6px 0 var(--space-3); }
.cp-trio span { display: flex; align-items: baseline; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.cp-trio b { font-size: 28px; line-height: 32px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
.cp-trio__0 b { color: var(--ink-faint); }
.cp-chart { display: block; width: 100%; overflow: visible; margin-bottom: var(--space-4); }
.cp-bar { fill: var(--running); }
.cp-peak { fill: var(--ink); }
.cp-slots { stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.cp-base { stroke: var(--line-strong); }
.cp-grid { stroke: var(--line); }
.cp-now { stroke: var(--ink); stroke-width: 1.5; }
.cp-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.cp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.cp-ll--now { fill: var(--ink); }
.cp-nd-bg { fill: var(--surface-2); }
.cp-nd-ln { fill: var(--line-strong); opacity: .55; }
.cp-key { display: grid; gap: 10px; }
.cp-proj { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.cp-proj > span { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
.cp-key li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-muted); }
.cp-key li b { color: var(--ink); margin-right: 4px; }
.cp-key svg { flex: none; overflow: visible; }

/* breakdown */
.bk-chart, .bk-cum, .bk-mchart { display: block; width: 100%; overflow: visible; }
.bk-bar { fill: var(--ok); }
.bk-est { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-floor { stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; }
.bk-zero { fill: var(--ink-faint); }
.bk-grid { stroke: var(--line); }
.bk-base { stroke: var(--line-strong); }
.bk-ax { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.bk-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.bk-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.bk-d--now { fill: var(--ink); font-weight: 750; }
.bk-cl { stroke: var(--ink-muted); stroke-width: 2; }
.bk-cl--est { stroke-dasharray: 5 4; }
.bk-cd { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 2; }
.bk-cum { margin-top: var(--space-2); }
.bk-k { display: inline-block; width: 16px; height: 10px; border-radius: 4px; }
.bk-k--bar { background: var(--ok); }
.bk-k--est { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.bk-k--floor { height: 3px; background: var(--ink); }
.bk-k--zero { height: 2px; background: var(--ink-faint); }
.bk-mult { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.bk-mf { padding: 12px 12px 6px; border-radius: var(--radius-md); background: var(--surface-2); }
.bk-mf figcaption { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.bk-mf figcaption span { font-weight: 700; }
.bk-sm { fill: var(--ink-muted); }
.bk-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.bk-h { font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.bk-h--2 { margin-top: var(--space-5); }
.bk-rows { display: grid; gap: 12px; }
.bk-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; align-items: center; font-size: 13px; }
.bk-row__l { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.bk-row__l small { font-size: 11px; color: var(--ink-muted); }
.bk-row__v { text-align: right; white-space: nowrap; }
.bk-hb { display: block; width: 100%; }
.bk-hb__bed { fill: var(--dot-off); }
.bk-hb__fill { fill: var(--ink-muted); }
.bk-hb__api { fill: none; stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-hb__zero { stroke: var(--ink); stroke-width: 2; }
.bk-tail { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1.5px var(--line-strong); color: var(--ink-muted); }
.pl { padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.pl + .pl { margin-top: 8px; }
.pl__h { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.pl__h > div { flex: 1; min-width: 0; }
.pl__t { font-size: 15px; font-weight: 700; }
.pl .facts { gap: 8px; }
.lg-l { display: grid; gap: 8px; }
.lg-l li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; color: var(--ink-muted); }
.lg-l li b { color: var(--ink); }
.lg-m { font-weight: 750; color: var(--ink); font-variant-numeric: tabular-nums; }
.wf-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: end; }
.wf-form .field:first-child { grid-column: 1 / -1; }
.wf-ans { margin-top: var(--space-4); padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.wf-ans__h { font-size: 13px; color: var(--ink-muted); }
.wf-ans__n { margin: 4px 0 10px; font-size: 18px; line-height: 26px; }
.wf-other { display: grid; gap: 8px; margin-top: var(--space-4); }
.wf-other__h { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.wf-o { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; }
.wf-o__s { margin-top: 2px; font-size: 12px; color: var(--ink-muted); }

/* flows map */
.fm-wrap { overflow-x: auto; border-radius: var(--radius-md); background: var(--canvas); }
.fm-svg { display: block; width: 100%; height: auto; }
.fm-zoom { display: flex; gap: 6px; }
.fm-zoom .roundbtn { width: 38px; height: 38px; background: var(--surface-2); }
.fm-g__b { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.fm-g__t { font-size: 14px; font-weight: 750; fill: var(--ink); }
.fm-g__s { font-size: 11px; font-weight: 500; fill: var(--ink-muted); }
.fm-trig__b { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.fm-flow__b { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 1.5; }
.fm-flow--unv .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--line-strong); }
.fm-flow--head .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--attention); }
.fm-flow--miss .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--failed); }
.fm-flow--orphan { opacity: .55; }
.fm-flow--orphan .fm-flow__b { stroke-dasharray: 2 4; }
.fm-trig--spent .fm-trig__b { stroke-dasharray: 2 4; fill: var(--surface); }
.fm-ic { color: var(--ink-muted); }
.fm-t { font-size: 14px; font-weight: 700; fill: var(--ink); }
.fm-s { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.fm-e path { fill: none; stroke: var(--ink-faint); stroke-width: 1.6; }
.fm-e--observed path { stroke: var(--ink-muted); stroke-width: 3.5; }
.fm-e--potential path { stroke-dasharray: 6 5; }
.fm-e--rearm path { stroke-dasharray: 3 4; }
.fm-el { font-size: 11px; font-weight: 650; fill: var(--ink-muted); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.fm-e .arrowhead, .fm-sw .arrowhead { fill: var(--ink-faint); }
.fm-bd--risk { fill: var(--refused); stroke: var(--surface); stroke-width: 2; }
.fm-bd--chain { fill: var(--surface); stroke: var(--ok); stroke-width: 3; }
.fm-n:focus-visible { outline: none; }
.fm-n:focus-visible rect:first-child { stroke: var(--focus); stroke-width: 3; }
.is-dim { opacity: .45; }
.is-sel .fm-trig__b { fill: var(--primary); stroke: var(--primary); }
.is-sel .fm-t { fill: var(--on-primary); }
.is-sel .fm-ic { color: var(--on-primary); }
.is-sel.fm-e path { stroke: var(--ink); stroke-width: 2.2; }
.is-near .fm-flow__b { stroke: var(--ink); stroke-width: 2.5; }
.fm-lgs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-5); }
.fm-lg__h { font-size: 12px; font-weight: 700; color: var(--ink-muted); margin-bottom: 8px; }
.fm-lg__h--gap { margin-top: var(--space-4); }
.fm-lg ul { display: grid; gap: 8px; }
.fm-lg li { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.fm-lg li b { color: var(--ink); margin-right: 3px; }
.fm-sw { flex: none; overflow: visible; }
.fm-caps { margin: var(--space-4) 0; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; font-weight: 600; }
.fm-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--space-4); }
.fm-selcard { box-shadow: inset 0 0 0 2px var(--primary); }

@media (max-width: 760px) {
  .al-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
  .al-row .al-bar { grid-column: 1 / -1; grid-row: 2; }
  .al-env__h { margin-left: 0; }
  .pr-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sx-pad { padding: 0 var(--space-4); } .sx-pad--b { padding-bottom: var(--space-4); }
  .cp-trio { gap: var(--space-4); }
  .cp-trio b { font-size: 22px; line-height: 26px; }
  .cp-d { font-size: 9px; }
  .bk-mult { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bk-cols { grid-template-columns: minmax(0, 1fr); gap: var(--space-5); }
  .bk-chart .bk-v { font-size: 10px; }
  .bk-chart .bk-d { font-size: 10px; }
  .wf-form { grid-template-columns: minmax(0, 1fr); }
  .fm-svg { min-width: 820px; }
  .fm-lgs { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .lg-l li { grid-template-columns: 84px minmax(0, 1fr); }
}


.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.sp-tabs { margin: var(--space-2) 0 var(--space-4); }
.sp-tabs a .ic { opacity: .8; }
.sp-kf { margin-top: 10px; font-size: 12px; color: var(--ink-muted); }
.sp-kf b { color: var(--ink); }
.sp-chart, .sp-hist, .sp-split { display: block; width: 100%; overflow: visible; }
.sp-bar { fill: var(--ok); }
.sp-held { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.sp-cap { stroke: var(--failed); stroke-width: 1.5; stroke-dasharray: 2 4; }
.sp-hold { stroke: var(--ink-faint); stroke-width: 1.5; stroke-dasharray: 5 4; }
.sp-base { stroke: var(--line); }
.sp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.sp-ll--cap { fill: var(--ink-muted); }
.sp-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-d { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.sp-d--now { fill: var(--ink); font-weight: 750; }
.sp-gap { font-size: 14px; font-weight: 700; fill: var(--ink-faint); }
.sp-hbin { fill: var(--ink-muted); }
.sp-capline { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 3 3; }
.sp-k { display: inline-block; width: 14px; height: 10px; border-radius: 4px; }
.sp-k--bar { background: var(--ok); }
.sp-k--held { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.sp-k--hold { height: 0; border-top: 2px dashed var(--ink-faint); border-radius: 0; }
.sp-hbars { display: grid; gap: 14px; }
.sp-hb { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-hb__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.sp-hb__l small { font-size: 11px; color: var(--ink-muted); }
.sp-hb__bar { display: block; width: 100%; }
.sp-hb__bed { fill: var(--dot-off); }
.sp-hb__fill { fill: var(--ink-muted); }
.sp-hb__v { text-align: right; white-space: nowrap; font-size: 13px; }
.sp-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sp-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sp-note--ic .ic { margin-top: 1px; }
.sp-note b { color: var(--ink); }
.sp-note--wide { margin: 0 4px; }
.sp-caps { display: grid; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; border-bottom: 1px solid var(--line); }
.sp-wiform { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.sp-wi__s { margin: var(--space-4) 0 var(--space-3); font-size: 15px; line-height: 22px; }
.sp-wi { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-wi__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; font-weight: 650; margin-top: 6px; }
.sp-wi__l small { font-weight: 500; font-size: 11px; color: var(--ink-muted); }
.sp-wi b { text-align: right; white-space: nowrap; }
.sp-mp { display: grid; gap: 6px; }
.sp-mp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sp-mp__t { display: flex; flex-direction: column; min-width: 0; }
.sp-mp__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.sp-mp__v { white-space: nowrap; }
.sp-mp__k { min-width: 64px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.sp-seg--0 { fill: var(--surface-3); } .sp-seg--1 { fill: var(--dot-off); }
.sp-seg { stroke: var(--surface); stroke-width: 3; }
.sp-seg__t { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-rows { display: grid; margin-top: 6px; }
.sp-rows .meterrow { grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .sp-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-3); }
  .sp-range { width: 100%; justify-content: space-between; }
  .sp-wiform { grid-template-columns: minmax(0, 1fr); }
  .sp-chart .sp-v { font-size: 10px; }
  .sp-chart .sp-d { font-size: 10px; }
  .sp-caps .meterrow, .sp-rows .meterrow { grid-template-columns: minmax(0, 104px) minmax(0, 1fr) auto; }
}

.sx-win { display: flex; align-items: center; gap: 6px; margin: -6px 4px 0; font-size: 12px; color: var(--ink-muted); }
.sx-k { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-k b { color: var(--ink); }
.sx-lead { margin: 0 4px; font-size: 13px; line-height: 19px; color: var(--ink-muted); max-width: 980px; }
.sx-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-note b { color: var(--ink); }
.sx-note--top { margin: 0 0 var(--space-3); }
.sx-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sx-note--ic .ic { margin-top: 1px; flex: none; }
.sx-note.tone-attention { color: var(--attention-ink); font-weight: 600; }
.sx-pad { padding: 0 var(--space-5); }
.sx-pad--b { padding-bottom: var(--space-5); }
.sx-lines { display: grid; gap: 8px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.sx-lines li { padding-left: 14px; position: relative; }
.sx-lines li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--ink-faint); }
.sx-lines b { color: var(--ink); }
.sx-states { display: grid; gap: 8px; }

/* budget split */
.al-env { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: var(--space-4); font-size: 15px; }
.al-env__h { margin-left: auto; font-size: 13px; color: var(--ink-muted); }
.al-env__h b { color: var(--ink); }
.al-rows { display: grid; gap: 4px; margin-top: var(--space-4); }
.al-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.al-row:last-child { border-bottom: 0; }
.al-row__l { display: flex; align-items: center; gap: 8px; }
.al-row__l small, .al-row__v small { font-size: 11px; color: var(--ink-muted); }
.al-row__v { display: flex; flex-direction: column; align-items: flex-end; font-size: 13px; color: var(--ink-muted); white-space: nowrap; }
.al-row__v b { color: var(--ink); }
.al-bar { display: block; width: 100%; overflow: visible; }
.al-bar__track { fill: var(--surface-2); }
.al-bar__alloc { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; }
.al-bar__spent { fill: var(--ok); }
.al-bar__spent--over { fill: var(--failed); }
.al-bar__floor { stroke: var(--attention); stroke-width: 3; stroke-linecap: round; }
.al-k { display: inline-block; width: 18px; height: 10px; border-radius: 5px; }
.al-k--alloc { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.al-k--spent { background: var(--ok); }
.al-k--floor { width: 3px; height: 14px; border-radius: 2px; background: var(--attention); }
.al-k--over { background: var(--failed); }
.al-sel td { background: var(--surface-2); }
.pr-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.pr-row { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.pr-row .ptag { justify-self: start; }
.pr-in { width: 100%; max-width: 120px; }
.pr-share { font-size: 12px; color: var(--ink-muted); }
.pr-foot { margin-top: var(--space-4); align-items: flex-end; }
.cn-h { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; margin: 4px 0 8px; }
.cn-h + .cn-l + .cn-h { margin-top: var(--space-4); }
.cn-l { display: grid; gap: 4px; }
.cn-l li { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.rs-l { display: grid; gap: 8px; }
.rs-l li { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.rs-l .ptag { justify-self: start; }
.rs-l q { font-size: 13px; line-height: 19px; color: var(--ink); quotes: "\201C" "\201D"; }

/* capacity */
.cp-trio { display: flex; gap: var(--space-5); margin: -6px 0 var(--space-3); }
.cp-trio span { display: flex; align-items: baseline; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.cp-trio b { font-size: 28px; line-height: 32px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
.cp-trio__0 b { color: var(--ink-faint); }
.cp-chart { display: block; width: 100%; overflow: visible; margin-bottom: var(--space-4); }
.cp-bar { fill: var(--running); }
.cp-peak { fill: var(--ink); }
.cp-slots { stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.cp-base { stroke: var(--line-strong); }
.cp-grid { stroke: var(--line); }
.cp-now { stroke: var(--ink); stroke-width: 1.5; }
.cp-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.cp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.cp-ll--now { fill: var(--ink); }
.cp-nd-bg { fill: var(--surface-2); }
.cp-nd-ln { fill: var(--line-strong); opacity: .55; }
.cp-key { display: grid; gap: 10px; }
.cp-proj { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.cp-proj > span { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
.cp-key li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-muted); }
.cp-key li b { color: var(--ink); margin-right: 4px; }
.cp-key svg { flex: none; overflow: visible; }

/* breakdown */
.bk-chart, .bk-cum, .bk-mchart { display: block; width: 100%; overflow: visible; }
.bk-bar { fill: var(--ok); }
.bk-est { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-floor { stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; }
.bk-zero { fill: var(--ink-faint); }
.bk-grid { stroke: var(--line); }
.bk-base { stroke: var(--line-strong); }
.bk-ax { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.bk-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.bk-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.bk-d--now { fill: var(--ink); font-weight: 750; }
.bk-cl { stroke: var(--ink-muted); stroke-width: 2; }
.bk-cl--est { stroke-dasharray: 5 4; }
.bk-cd { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 2; }
.bk-cum { margin-top: var(--space-2); }
.bk-k { display: inline-block; width: 16px; height: 10px; border-radius: 4px; }
.bk-k--bar { background: var(--ok); }
.bk-k--est { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.bk-k--floor { height: 3px; background: var(--ink); }
.bk-k--zero { height: 2px; background: var(--ink-faint); }
.bk-mult { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.bk-mf { padding: 12px 12px 6px; border-radius: var(--radius-md); background: var(--surface-2); }
.bk-mf figcaption { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.bk-mf figcaption span { font-weight: 700; }
.bk-sm { fill: var(--ink-muted); }
.bk-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.bk-h { font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.bk-h--2 { margin-top: var(--space-5); }
.bk-rows { display: grid; gap: 12px; }
.bk-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; align-items: center; font-size: 13px; }
.bk-row__l { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.bk-row__l small { font-size: 11px; color: var(--ink-muted); }
.bk-row__v { text-align: right; white-space: nowrap; }
.bk-hb { display: block; width: 100%; }
.bk-hb__bed { fill: var(--dot-off); }
.bk-hb__fill { fill: var(--ink-muted); }
.bk-hb__api { fill: none; stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-hb__zero { stroke: var(--ink); stroke-width: 2; }
.bk-tail { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1.5px var(--line-strong); color: var(--ink-muted); }
.pl { padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.pl + .pl { margin-top: 8px; }
.pl__h { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.pl__h > div { flex: 1; min-width: 0; }
.pl__t { font-size: 15px; font-weight: 700; }
.pl .facts { gap: 8px; }
.lg-l { display: grid; gap: 8px; }
.lg-l li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; color: var(--ink-muted); }
.lg-l li b { color: var(--ink); }
.lg-m { font-weight: 750; color: var(--ink); font-variant-numeric: tabular-nums; }
.wf-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: end; }
.wf-form .field:first-child { grid-column: 1 / -1; }
.wf-ans { margin-top: var(--space-4); padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.wf-ans__h { font-size: 13px; color: var(--ink-muted); }
.wf-ans__n { margin: 4px 0 10px; font-size: 18px; line-height: 26px; }
.wf-other { display: grid; gap: 8px; margin-top: var(--space-4); }
.wf-other__h { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.wf-o { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; }
.wf-o__s { margin-top: 2px; font-size: 12px; color: var(--ink-muted); }

/* flows map */
.fm-wrap { overflow-x: auto; border-radius: var(--radius-md); background: var(--canvas); }
.fm-svg { display: block; width: 100%; height: auto; }
.fm-zoom { display: flex; gap: 6px; }
.fm-zoom .roundbtn { width: 38px; height: 38px; background: var(--surface-2); }
.fm-g__b { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.fm-g__t { font-size: 14px; font-weight: 750; fill: var(--ink); }
.fm-g__s { font-size: 11px; font-weight: 500; fill: var(--ink-muted); }
.fm-trig__b { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.fm-flow__b { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 1.5; }
.fm-flow--unv .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--line-strong); }
.fm-flow--head .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--attention); }
.fm-flow--miss .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--failed); }
.fm-flow--orphan { opacity: .55; }
.fm-flow--orphan .fm-flow__b { stroke-dasharray: 2 4; }
.fm-trig--spent .fm-trig__b { stroke-dasharray: 2 4; fill: var(--surface); }
.fm-ic { color: var(--ink-muted); }
.fm-t { font-size: 14px; font-weight: 700; fill: var(--ink); }
.fm-s { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.fm-e path { fill: none; stroke: var(--ink-faint); stroke-width: 1.6; }
.fm-e--observed path { stroke: var(--ink-muted); stroke-width: 3.5; }
.fm-e--potential path { stroke-dasharray: 6 5; }
.fm-e--rearm path { stroke-dasharray: 3 4; }
.fm-el { font-size: 11px; font-weight: 650; fill: var(--ink-muted); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.fm-e .arrowhead, .fm-sw .arrowhead { fill: var(--ink-faint); }
.fm-bd--risk { fill: var(--refused); stroke: var(--surface); stroke-width: 2; }
.fm-bd--chain { fill: var(--surface); stroke: var(--ok); stroke-width: 3; }
.fm-n:focus-visible { outline: none; }
.fm-n:focus-visible rect:first-child { stroke: var(--focus); stroke-width: 3; }
.is-dim { opacity: .45; }
.is-sel .fm-trig__b { fill: var(--primary); stroke: var(--primary); }
.is-sel .fm-t { fill: var(--on-primary); }
.is-sel .fm-ic { color: var(--on-primary); }
.is-sel.fm-e path { stroke: var(--ink); stroke-width: 2.2; }
.is-near .fm-flow__b { stroke: var(--ink); stroke-width: 2.5; }
.fm-lgs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-5); }
.fm-lg__h { font-size: 12px; font-weight: 700; color: var(--ink-muted); margin-bottom: 8px; }
.fm-lg__h--gap { margin-top: var(--space-4); }
.fm-lg ul { display: grid; gap: 8px; }
.fm-lg li { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.fm-lg li b { color: var(--ink); margin-right: 3px; }
.fm-sw { flex: none; overflow: visible; }
.fm-caps { margin: var(--space-4) 0; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; font-weight: 600; }
.fm-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--space-4); }
.fm-selcard { box-shadow: inset 0 0 0 2px var(--primary); }

@media (max-width: 760px) {
  .al-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
  .al-row .al-bar { grid-column: 1 / -1; grid-row: 2; }
  .al-env__h { margin-left: 0; }
  .pr-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sx-pad { padding: 0 var(--space-4); } .sx-pad--b { padding-bottom: var(--space-4); }
  .cp-trio { gap: var(--space-4); }
  .cp-trio b { font-size: 22px; line-height: 26px; }
  .cp-d { font-size: 9px; }
  .bk-mult { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bk-cols { grid-template-columns: minmax(0, 1fr); gap: var(--space-5); }
  .bk-chart .bk-v { font-size: 10px; }
  .bk-chart .bk-d { font-size: 10px; }
  .wf-form { grid-template-columns: minmax(0, 1fr); }
  .fm-svg { min-width: 820px; }
  .fm-lgs { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .lg-l li { grid-template-columns: 84px minmax(0, 1fr); }
}


.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.sp-tabs { margin: var(--space-2) 0 var(--space-4); }
.sp-tabs a .ic { opacity: .8; }
.sp-kf { margin-top: 10px; font-size: 12px; color: var(--ink-muted); }
.sp-kf b { color: var(--ink); }
.sp-chart, .sp-hist, .sp-split { display: block; width: 100%; overflow: visible; }
.sp-bar { fill: var(--ok); }
.sp-held { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.sp-cap { stroke: var(--failed); stroke-width: 1.5; stroke-dasharray: 2 4; }
.sp-hold { stroke: var(--ink-faint); stroke-width: 1.5; stroke-dasharray: 5 4; }
.sp-base { stroke: var(--line); }
.sp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.sp-ll--cap { fill: var(--ink-muted); }
.sp-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-d { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.sp-d--now { fill: var(--ink); font-weight: 750; }
.sp-gap { font-size: 14px; font-weight: 700; fill: var(--ink-faint); }
.sp-hbin { fill: var(--ink-muted); }
.sp-capline { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 3 3; }
.sp-k { display: inline-block; width: 14px; height: 10px; border-radius: 4px; }
.sp-k--bar { background: var(--ok); }
.sp-k--held { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.sp-k--hold { height: 0; border-top: 2px dashed var(--ink-faint); border-radius: 0; }
.sp-hbars { display: grid; gap: 14px; }
.sp-hb { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-hb__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.sp-hb__l small { font-size: 11px; color: var(--ink-muted); }
.sp-hb__bar { display: block; width: 100%; }
.sp-hb__bed { fill: var(--dot-off); }
.sp-hb__fill { fill: var(--ink-muted); }
.sp-hb__v { text-align: right; white-space: nowrap; font-size: 13px; }
.sp-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sp-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sp-note--ic .ic { margin-top: 1px; }
.sp-note b { color: var(--ink); }
.sp-note--wide { margin: 0 4px; }
.sp-caps { display: grid; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; border-bottom: 1px solid var(--line); }
.sp-wiform { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.sp-wi__s { margin: var(--space-4) 0 var(--space-3); font-size: 15px; line-height: 22px; }
.sp-wi { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-wi__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; font-weight: 650; margin-top: 6px; }
.sp-wi__l small { font-weight: 500; font-size: 11px; color: var(--ink-muted); }
.sp-wi b { text-align: right; white-space: nowrap; }
.sp-mp { display: grid; gap: 6px; }
.sp-mp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sp-mp__t { display: flex; flex-direction: column; min-width: 0; }
.sp-mp__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.sp-mp__v { white-space: nowrap; }
.sp-mp__k { min-width: 64px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.sp-seg--0 { fill: var(--surface-3); } .sp-seg--1 { fill: var(--dot-off); }
.sp-seg { stroke: var(--surface); stroke-width: 3; }
.sp-seg__t { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-rows { display: grid; margin-top: 6px; }
.sp-rows .meterrow { grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .sp-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-3); }
  .sp-range { width: 100%; justify-content: space-between; }
  .sp-wiform { grid-template-columns: minmax(0, 1fr); }
  .sp-chart .sp-v { font-size: 10px; }
  .sp-chart .sp-d { font-size: 10px; }
  .sp-caps .meterrow, .sp-rows .meterrow { grid-template-columns: minmax(0, 104px) minmax(0, 1fr) auto; }
}

.sx-win { display: flex; align-items: center; gap: 6px; margin: -6px 4px 0; font-size: 12px; color: var(--ink-muted); }
.sx-k { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-k b { color: var(--ink); }
.sx-lead { margin: 0 4px; font-size: 13px; line-height: 19px; color: var(--ink-muted); max-width: 980px; }
.sx-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sx-note b { color: var(--ink); }
.sx-note--top { margin: 0 0 var(--space-3); }
.sx-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sx-note--ic .ic { margin-top: 1px; flex: none; }
.sx-note.tone-attention { color: var(--attention-ink); font-weight: 600; }
.sx-pad { padding: 0 var(--space-5); }
.sx-pad--b { padding-bottom: var(--space-5); }
.sx-lines { display: grid; gap: 8px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
.sx-lines li { padding-left: 14px; position: relative; }
.sx-lines li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--ink-faint); }
.sx-lines b { color: var(--ink); }
.sx-states { display: grid; gap: 8px; }

/* budget split */
.al-env { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: var(--space-4); font-size: 15px; }
.al-env__h { margin-left: auto; font-size: 13px; color: var(--ink-muted); }
.al-env__h b { color: var(--ink); }
.al-rows { display: grid; gap: 4px; margin-top: var(--space-4); }
.al-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.al-row:last-child { border-bottom: 0; }
.al-row__l { display: flex; align-items: center; gap: 8px; }
.al-row__l small, .al-row__v small { font-size: 11px; color: var(--ink-muted); }
.al-row__v { display: flex; flex-direction: column; align-items: flex-end; font-size: 13px; color: var(--ink-muted); white-space: nowrap; }
.al-row__v b { color: var(--ink); }
.al-bar { display: block; width: 100%; overflow: visible; }
.al-bar__track { fill: var(--surface-2); }
.al-bar__alloc { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; }
.al-bar__spent { fill: var(--ok); }
.al-bar__spent--over { fill: var(--failed); }
.al-bar__floor { stroke: var(--attention); stroke-width: 3; stroke-linecap: round; }
.al-k { display: inline-block; width: 18px; height: 10px; border-radius: 5px; }
.al-k--alloc { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.al-k--spent { background: var(--ok); }
.al-k--floor { width: 3px; height: 14px; border-radius: 2px; background: var(--attention); }
.al-k--over { background: var(--failed); }
.al-sel td { background: var(--surface-2); }
.pr-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.pr-row { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.pr-row .ptag { justify-self: start; }
.pr-in { width: 100%; max-width: 120px; }
.pr-share { font-size: 12px; color: var(--ink-muted); }
.pr-foot { margin-top: var(--space-4); align-items: flex-end; }
.cn-h { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; margin: 4px 0 8px; }
.cn-h + .cn-l + .cn-h { margin-top: var(--space-4); }
.cn-l { display: grid; gap: 4px; }
.cn-l li { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.rs-l { display: grid; gap: 8px; }
.rs-l li { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.rs-l .ptag { justify-self: start; }
.rs-l q { font-size: 13px; line-height: 19px; color: var(--ink); quotes: "\201C" "\201D"; }

/* capacity */
.cp-trio { display: flex; gap: var(--space-5); margin: -6px 0 var(--space-3); }
.cp-trio span { display: flex; align-items: baseline; gap: 6px; font-size: 13px; color: var(--ink-muted); }
.cp-trio b { font-size: 28px; line-height: 32px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
.cp-trio__0 b { color: var(--ink-faint); }
.cp-chart { display: block; width: 100%; overflow: visible; margin-bottom: var(--space-4); }
.cp-bar { fill: var(--running); }
.cp-peak { fill: var(--ink); }
.cp-slots { stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.cp-base { stroke: var(--line-strong); }
.cp-grid { stroke: var(--line); }
.cp-now { stroke: var(--ink); stroke-width: 1.5; }
.cp-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.cp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.cp-ll--now { fill: var(--ink); }
.cp-nd-bg { fill: var(--surface-2); }
.cp-nd-ln { fill: var(--line-strong); opacity: .55; }
.cp-key { display: grid; gap: 10px; }
.cp-proj { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.cp-proj > span { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
.cp-key li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-muted); }
.cp-key li b { color: var(--ink); margin-right: 4px; }
.cp-key svg { flex: none; overflow: visible; }

/* breakdown */
.bk-chart, .bk-cum, .bk-mchart { display: block; width: 100%; overflow: visible; }
.bk-bar { fill: var(--ok); }
.bk-est { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-floor { stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; }
.bk-zero { fill: var(--ink-faint); }
.bk-grid { stroke: var(--line); }
.bk-base { stroke: var(--line-strong); }
.bk-ax { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.bk-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.bk-d { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.bk-d--now { fill: var(--ink); font-weight: 750; }
.bk-cl { stroke: var(--ink-muted); stroke-width: 2; }
.bk-cl--est { stroke-dasharray: 5 4; }
.bk-cd { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 2; }
.bk-cum { margin-top: var(--space-2); }
.bk-k { display: inline-block; width: 16px; height: 10px; border-radius: 4px; }
.bk-k--bar { background: var(--ok); }
.bk-k--est { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.bk-k--floor { height: 3px; background: var(--ink); }
.bk-k--zero { height: 2px; background: var(--ink-faint); }
.bk-mult { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.bk-mf { padding: 12px 12px 6px; border-radius: var(--radius-md); background: var(--surface-2); }
.bk-mf figcaption { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-bottom: 6px; }
.bk-mf figcaption span { font-weight: 700; }
.bk-sm { fill: var(--ink-muted); }
.bk-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.bk-h { font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.bk-h--2 { margin-top: var(--space-5); }
.bk-rows { display: grid; gap: 12px; }
.bk-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; align-items: center; font-size: 13px; }
.bk-row__l { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.bk-row__l small { font-size: 11px; color: var(--ink-muted); }
.bk-row__v { text-align: right; white-space: nowrap; }
.bk-hb { display: block; width: 100%; }
.bk-hb__bed { fill: var(--dot-off); }
.bk-hb__fill { fill: var(--ink-muted); }
.bk-hb__api { fill: none; stroke: var(--ink-muted); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bk-hb__zero { stroke: var(--ink); stroke-width: 2; }
.bk-tail { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1.5px var(--line-strong); color: var(--ink-muted); }
.pl { padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.pl + .pl { margin-top: 8px; }
.pl__h { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.pl__h > div { flex: 1; min-width: 0; }
.pl__t { font-size: 15px; font-weight: 700; }
.pl .facts { gap: 8px; }
.lg-l { display: grid; gap: 8px; }
.lg-l li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; color: var(--ink-muted); }
.lg-l li b { color: var(--ink); }
.lg-m { font-weight: 750; color: var(--ink); font-variant-numeric: tabular-nums; }
.wf-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: end; }
.wf-form .field:first-child { grid-column: 1 / -1; }
.wf-ans { margin-top: var(--space-4); padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.wf-ans__h { font-size: 13px; color: var(--ink-muted); }
.wf-ans__n { margin: 4px 0 10px; font-size: 18px; line-height: 26px; }
.wf-other { display: grid; gap: 8px; margin-top: var(--space-4); }
.wf-other__h { font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.wf-o { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; }
.wf-o__s { margin-top: 2px; font-size: 12px; color: var(--ink-muted); }

/* flows map */
.fm-wrap { overflow-x: auto; border-radius: var(--radius-md); background: var(--canvas); }
.fm-svg { display: block; width: 100%; height: auto; }
.fm-zoom { display: flex; gap: 6px; }
.fm-zoom .roundbtn { width: 38px; height: 38px; background: var(--surface-2); }
.fm-g__b { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.fm-g__t { font-size: 14px; font-weight: 750; fill: var(--ink); }
.fm-g__s { font-size: 11px; font-weight: 500; fill: var(--ink-muted); }
.fm-trig__b { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.fm-flow__b { fill: var(--surface); stroke: var(--ink-muted); stroke-width: 1.5; }
.fm-flow--unv .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--line-strong); }
.fm-flow--head .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--attention); }
.fm-flow--miss .fm-flow__b { stroke-dasharray: 5 4; stroke: var(--failed); }
.fm-flow--orphan { opacity: .55; }
.fm-flow--orphan .fm-flow__b { stroke-dasharray: 2 4; }
.fm-trig--spent .fm-trig__b { stroke-dasharray: 2 4; fill: var(--surface); }
.fm-ic { color: var(--ink-muted); }
.fm-t { font-size: 14px; font-weight: 700; fill: var(--ink); }
.fm-s { font-size: 11px; font-weight: 600; fill: var(--ink-muted); }
.fm-e path { fill: none; stroke: var(--ink-faint); stroke-width: 1.6; }
.fm-e--observed path { stroke: var(--ink-muted); stroke-width: 3.5; }
.fm-e--potential path { stroke-dasharray: 6 5; }
.fm-e--rearm path { stroke-dasharray: 3 4; }
.fm-el { font-size: 11px; font-weight: 650; fill: var(--ink-muted); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.fm-e .arrowhead, .fm-sw .arrowhead { fill: var(--ink-faint); }
.fm-bd--risk { fill: var(--refused); stroke: var(--surface); stroke-width: 2; }
.fm-bd--chain { fill: var(--surface); stroke: var(--ok); stroke-width: 3; }
.fm-n:focus-visible { outline: none; }
.fm-n:focus-visible rect:first-child { stroke: var(--focus); stroke-width: 3; }
.is-dim { opacity: .45; }
.is-sel .fm-trig__b { fill: var(--primary); stroke: var(--primary); }
.is-sel .fm-t { fill: var(--on-primary); }
.is-sel .fm-ic { color: var(--on-primary); }
.is-sel.fm-e path { stroke: var(--ink); stroke-width: 2.2; }
.is-near .fm-flow__b { stroke: var(--ink); stroke-width: 2.5; }
.fm-lgs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-5); }
.fm-lg__h { font-size: 12px; font-weight: 700; color: var(--ink-muted); margin-bottom: 8px; }
.fm-lg__h--gap { margin-top: var(--space-4); }
.fm-lg ul { display: grid; gap: 8px; }
.fm-lg li { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
.fm-lg li b { color: var(--ink); margin-right: 3px; }
.fm-sw { flex: none; overflow: visible; }
.fm-caps { margin: var(--space-4) 0; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 12px; font-weight: 600; }
.fm-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--space-4); }
.fm-selcard { box-shadow: inset 0 0 0 2px var(--primary); }

@media (max-width: 760px) {
  .al-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
  .al-row .al-bar { grid-column: 1 / -1; grid-row: 2; }
  .al-env__h { margin-left: 0; }
  .pr-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sx-pad { padding: 0 var(--space-4); } .sx-pad--b { padding-bottom: var(--space-4); }
  .cp-trio { gap: var(--space-4); }
  .cp-trio b { font-size: 22px; line-height: 26px; }
  .cp-d { font-size: 9px; }
  .bk-mult { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bk-cols { grid-template-columns: minmax(0, 1fr); gap: var(--space-5); }
  .bk-chart .bk-v { font-size: 10px; }
  .bk-chart .bk-d { font-size: 10px; }
  .wf-form { grid-template-columns: minmax(0, 1fr); }
  .fm-svg { min-width: 820px; }
  .fm-lgs { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .lg-l li { grid-template-columns: 84px minmax(0, 1fr); }
}


.sp-range { background: var(--surface); height: 48px; align-items: center; padding: 0 5px; }
.sp-range button { height: 38px; padding: 0 14px; font-size: 13px; }
.sp-range [aria-pressed="true"] { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.sp-tabs { margin: var(--space-2) 0 var(--space-4); }
.sp-tabs a .ic { opacity: .8; }
.sp-kf { margin-top: 10px; font-size: 12px; color: var(--ink-muted); }
.sp-kf b { color: var(--ink); }
.sp-chart, .sp-hist, .sp-split { display: block; width: 100%; overflow: visible; }
.sp-bar { fill: var(--ok); }
.sp-held { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.sp-cap { stroke: var(--failed); stroke-width: 1.5; stroke-dasharray: 2 4; }
.sp-hold { stroke: var(--ink-faint); stroke-width: 1.5; stroke-dasharray: 5 4; }
.sp-base { stroke: var(--line); }
.sp-ll { font-size: 11px; font-weight: 650; fill: var(--ink-muted); }
.sp-ll--cap { fill: var(--ink-muted); }
.sp-v { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-d { font-size: 11px; font-weight: 600; fill: var(--ink-faint); }
.sp-d--now { fill: var(--ink); font-weight: 750; }
.sp-gap { font-size: 14px; font-weight: 700; fill: var(--ink-faint); }
.sp-hbin { fill: var(--ink-muted); }
.sp-capline { stroke: var(--failed); stroke-width: 2; stroke-dasharray: 3 3; }
.sp-k { display: inline-block; width: 14px; height: 10px; border-radius: 4px; }
.sp-k--bar { background: var(--ok); }
.sp-k--held { background: var(--ok-tint); box-shadow: inset 0 0 0 1.5px var(--ok); }
.sp-k--hold { height: 0; border-top: 2px dashed var(--ink-faint); border-radius: 0; }
.sp-hbars { display: grid; gap: 14px; }
.sp-hb { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-hb__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.sp-hb__l small { font-size: 11px; color: var(--ink-muted); }
.sp-hb__bar { display: block; width: 100%; }
.sp-hb__bed { fill: var(--dot-off); }
.sp-hb__fill { fill: var(--ink-muted); }
.sp-hb__v { text-align: right; white-space: nowrap; font-size: 13px; }
.sp-note { margin-top: 10px; font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.sp-note--ic { display: flex; gap: 6px; align-items: flex-start; }
.sp-note--ic .ic { margin-top: 1px; }
.sp-note b { color: var(--ink); }
.sp-note--wide { margin: 0 4px; }
.sp-caps { display: grid; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; border-bottom: 1px solid var(--line); }
.sp-wiform { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.sp-wi__s { margin: var(--space-4) 0 var(--space-3); font-size: 15px; line-height: 22px; }
.sp-wi { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; font-size: 13px; }
.sp-wi__l { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; font-weight: 650; margin-top: 6px; }
.sp-wi__l small { font-weight: 500; font-size: 11px; color: var(--ink-muted); }
.sp-wi b { text-align: right; white-space: nowrap; }
.sp-mp { display: grid; gap: 6px; }
.sp-mp li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sp-mp__t { display: flex; flex-direction: column; min-width: 0; }
.sp-mp__t small { font-size: 12px; color: var(--ink-muted); line-height: 16px; }
.sp-mp__v { white-space: nowrap; }
.sp-mp__k { min-width: 64px; font-size: 12px; font-weight: 650; color: var(--ink-muted); }
.sp-seg--0 { fill: var(--surface-3); } .sp-seg--1 { fill: var(--dot-off); }
.sp-seg { stroke: var(--surface); stroke-width: 3; }
.sp-seg__t { font-size: 12px; font-weight: 750; fill: var(--ink); }
.sp-rows { display: grid; margin-top: 6px; }
.sp-rows .meterrow { grid-template-columns: minmax(0, 200px) minmax(0, 1fr) auto; }
@media (max-width: 760px) {
  .sp-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-3); }
  .sp-range { width: 100%; justify-content: space-between; }
  .sp-wiform { grid-template-columns: minmax(0, 1fr); }
  .sp-chart .sp-v { font-size: 10px; }
  .sp-chart .sp-d { font-size: 10px; }
  .sp-caps .meterrow, .sp-rows .meterrow { grid-template-columns: minmax(0, 104px) minmax(0, 1fr) auto; }
}
`;
const adapters = `
/* The copied cards use buttons for sample controls; the console uses real navigation links. */
.spend-tabs a[aria-current="page"], .spend-controls .seg a[aria-current="page"] { background: var(--primary); color: var(--on-primary); }
.spend-tabs { display: flex; flex-wrap: nowrap; gap: 6px; }
.spend-tabs > a { flex: none; }
.sp-kpi { gap: 8px; }
.sp-kpi .kpi { margin-bottom: 2px; }
.sp-kpi .facts { gap: 0; }
.sp-kpi .fact { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding: 3px 0; font-size: 11px; line-height: 16px; }
.sp-kpi .sp-kf { margin-top: 0; }
.spend-whatif input, .spend-whatif select { background: var(--surface-2); }
.sp-provenance { font-size: 11px; line-height: 16px; color: var(--ink-muted); }
.sp-provenance > summary { cursor: pointer; }
#p-plan-kpi .kpi b { font-size: 40px; }
#p-plan-kpi .note { overflow-wrap: anywhere; }
#p-over .sp-chart { display: block; width: 100%; height: 230px; max-width: 100%; }
#p-over .sp-plot { border: 0; border-radius: 0; }
#p-sizes .sp-hist { display: block; width: 100%; height: 180px; max-width: 100%; }
#p-split .sp-split { display: block; width: 100%; height: 34px; }
.sp-costs { min-width: 0; }
.sp-costs section { min-width: 0; }
.sp-costs .card__body { gap: 10px; }
.sp-hb__l b, .sp-mp__t b { overflow-wrap: anywhere; }
.sp-hb__v { max-width: 92px; white-space: normal; overflow-wrap: anywhere; }
.sp-mp__v { max-width: 110px; white-space: normal; overflow-wrap: anywhere; }
.sp-mp__k { min-width: 0; }
.sp-caps .meterrow { grid-template-columns: minmax(0, 130px) minmax(0, 1fr) auto; }
.sp-caps .meterrow__v { font-size: 12px; }
.sp-caps .meterrow__l { overflow-wrap: anywhere; font-size: 12px; }
.sp-cap-key { flex-direction: column; align-items: flex-start; }
.pr-row { font-size: 12px; }
.pr-row .pr-in { max-width: 100%; }
.rs-l q { overflow-wrap: anywhere; }
.rs-l { margin: 0; padding: 0; list-style: none; }
.cn-l { margin: 0; padding: 0; list-style: none; }
.cn-l .code { min-width: 0; overflow-wrap: anywhere; }
#p-cap-hosts .cp-chart { display: block; width: 100%; max-width: 100%; height: 144px; }
.cp-trio { flex-wrap: wrap; }
.cp-host-meta { font-size: 13px; color: var(--ink-muted); }
.cp-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; }
.cp-facts .facts { min-width: 0; }
.cp-facts .fact { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); }
.cp-caveat { color: var(--attention-ink); }
.cp-hatch { stroke: var(--line-strong); stroke-width: 1; fill: none; }
.cp-peak-line { stroke: var(--ink); stroke-width: 2; }
.cp-key svg { width: 22px; height: 16px; flex: none; }
@media (max-width: 1100px) and (min-width: 761px) {
 .spend-costs { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 760px) {
 .spend-grid { display: flex; flex-direction: column; gap: var(--space-3); }
 .spend-main, .spend-side { display: contents; }
 .spend-grid #p-over { order: 1; }
 .spend-grid .spend-costs { order: 2; width: 100%; grid-template-columns: minmax(0, 1fr); }
 .spend-grid #p-sizes { order: 3; }
 .spend-grid #p-caps { order: 4; }
 .spend-grid #p-whatif { order: 5; }
 .spend-grid #p-plan { order: 6; }
 .spend-grid #p-split { order: 7; }
 .spend-grid > section, .spend-grid .spend-main > section, .spend-grid .spend-side > section { width: 100%; }
 .sp-caps .meterrow { grid-template-columns: minmax(0, 100px) minmax(0, 1fr) auto; }
}
@media (max-width: 600px) { .cp-facts { grid-template-columns: minmax(0, 1fr); } }

#p-plan-kpi .kpi b { font-size: 40px; overflow-wrap: anywhere; min-width: 0; max-width: 100%; }
.spend-tabs { margin: var(--space-2) 0 var(--space-4); min-width: 0; max-width: 100%; overflow-x: auto; }
.spend-tabs .seg { width: max-content; min-width: 0; flex-wrap: nowrap; }
.spend-controls { display: grid; gap: 8px; max-width: 100%; min-width: 0; }
.spend-controls .seg { flex-wrap: nowrap; white-space: nowrap; }
.spend-projects { min-width: 0; max-width: 100%; overflow-x: auto; }
.spend-projects .seg { width: max-content; }
.card__body { padding: 0 var(--space-5) var(--space-5); display: grid; gap: 12px; min-width: 0; }
.caps, .honesty { font-size: 12px; color: var(--ink-muted); }
.dim, .small, .pv { color: var(--ink-muted); font-size: 12px; }
.hidden-tips { display: none; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.plan { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; min-width: 0; }
.pid { font-weight: 650; }
.note { color: var(--ink-muted); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.mono { font-family: var(--font-mono); overflow-wrap: anywhere; }
.sp-bar--estimated { fill: var(--ok-tint); stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 4 3; }
.spend-chart { display: block; width: 100%; max-width: 100%; height: auto; }
.spend-meter { display: block; width: 100%; height: 9px; }
.spend-cap { display: grid; gap: 5px; min-width: 0; }
.spend-cap .row { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 5px; }
.spend-cap .end { margin-left: auto; }
.spend-whatif, .spend-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.spend-whatif label, .spend-fields label { display: grid; gap: 6px; min-width: 0; font-size: 12px; color: var(--ink-muted); }
.spend-whatif input, .spend-whatif select, .spend-fields input, .spend-fields select { min-width: 0; width: 100%; padding: 8px 10px; color: var(--ink); border: 1px solid var(--line-strong); border-radius: var(--radius-md); background: var(--surface); }
.spend-fields input[type=checkbox] { width: auto; }
.spend-whatif input, .spend-whatif select { background: var(--surface-2); }
.spend-whatif button, .spend-fields button { grid-column: 1 / -1; justify-self: start; }
.table-scroll { min-width: 0; max-width: 100%; overflow-x: auto; }
table.table { width: 100%; border-collapse: collapse; font-size: 12px; }
table.table th, table.table td { padding: 9px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
#wrap { position: relative; max-width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius-md); }
svg.canvas { display: block; max-width: 100%; height: auto; min-height: 220px; max-height: 75vh; cursor: grab; touch-action: none; }
#tip { position: absolute; display: none; max-width: 300px; padding: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-md); color: var(--ink); white-space: pre-line; pointer-events: none; z-index: 4; }
.gnode { cursor: pointer; }
.gnode:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }
.dim .gnode, .dim .gwire { opacity: .15; }
.dim .hi { opacity: 1; }
#legend, #dollars { display: none; }
.card__body section { min-width: 0; }
#p-cap-hosts .cap { display: block; width: 100%; text-align: left; }
#p-cap-hosts .bl { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; margin: 12px 0; }
#p-cap-hosts svg, #p-daily svg, #p-daily-flow svg { display: block; width: 100%; height: auto; max-width: 100%; }
#p-cap-hosts .small, #prov { color: var(--ink-muted); font-size: 12px; overflow-wrap: anywhere; }
#p-cap-hosts .cap-warn { color: var(--attention-ink); }
#p-cap-hosts table { width: 100%; font-size: 12px; }
@media (min-width: 761px) and (max-width: 1180px) {
 .cards-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
 .spend-controls { width: 100%; }
 .spend-controls > .seg { width: 100%; justify-content: space-between; }
 .spend-whatif, .spend-fields { grid-template-columns: minmax(0, 1fr); }
 .card__body { padding: 0 var(--space-4) var(--space-4); }
 #p-flows svg.canvas { min-width: 720px; max-width: none; max-height: none; }
}
`;
const paints = [];
for (const [role, hex] of Object.entries(PAGE_THEME)) {
  const token = PD_TOKENS[role];
  if (token)
    paints.push(
      `svg [fill="${hex}"]{fill:var(--${token})} svg [stroke="${hex}"]{stroke:var(--${token})}`,
    );
}
for (const [hex, [fill, stroke]] of Object.entries(SVG_EXTRA))
  paints.push(
    `svg [fill="${hex}"]{fill:var(--${fill})} svg [stroke="${hex}"]{stroke:var(--${stroke})}`,
  );
export const SPEND_CSS = SPEND_DESIGN_CSS + adapters + paints.join("\n");

// Pinned in console-spend.test: the copies keep page-css free of a cycle through the temporary compatibility layer.
export { PD_TOKENS as SPEND_PAINT_TOKENS, SVG_EXTRA as SPEND_EXTRA_PAINTS };
