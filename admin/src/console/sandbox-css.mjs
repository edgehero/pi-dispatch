/** SandboxesScreen page rules, pasted from its generator (#771). */
export const SANDBOX_CSS = `
/* Published ids and bounded request ids must wrap inside cards and state banners, including on a phone. */
.code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.banner__t, .banner__s { overflow-wrap: anywhere; }
/* Keep fact values readable inside a narrow desktop card as well as on a phone. */
.facts, .facts--3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.facts--1 { grid-template-columns: minmax(0, 1fr); }
.fact { grid-template-columns: minmax(0, min(128px, 40%)) minmax(0, 1fr); }
.sx-picker { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-3); margin-bottom: var(--space-4); }
.sx-picker .field { flex: 1 1 240px; }
.sx-form-end { margin-top: var(--space-3); }
.sx-kept__actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: start; gap: var(--space-2); }
.sx-kept__actions details { min-width: 0; flex: 1 1 240px; }
.sx-open__a details { min-width: 0; max-width: 100%; }
.sx-open__a { align-items: start; }
.sx-ch > .cmd { margin-top: 8px; }
.sx-ch details summary { cursor: pointer; }
@media (max-width: 760px) { .sandbox-opener { display: none !important; } }

.sx-tabs { margin: 0 0 var(--space-4); }
.sx-tabs .count { background: var(--surface-3); color: var(--ink-muted); }
.sx-tabs a[aria-current="page"] .count { background: var(--on-primary); color: var(--primary); }
.sx-h3 { font-size: 13px; font-weight: 700; color: var(--ink); margin: var(--space-5) 0 var(--space-2); }
.sx-h3--top { margin-top: 0; }
.sx-p { font-size: 13px; line-height: 20px; color: var(--ink-muted); margin-bottom: var(--space-2); }
.sx-run { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.sx-run__t { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; font-weight: 650; }
.sx-run__s { margin-top: 4px; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.sx-run__s b { color: var(--ink); }
.sx-chs { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.sx-ch .cmd { max-width: 560px; }
.sx-ch { position: relative; display: grid; align-content: start; gap: 8px; min-width: 0; padding: 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); cursor: pointer; }
.sx-ch input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.sx-ch--on { box-shadow: inset 0 0 0 2px var(--primary); }
.sx-ch--off { background: var(--surface-2); cursor: not-allowed; }
.sx-ch:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
.sx-ch__h { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 14px; color: var(--ink); }
.sx-ch__h .chip { margin-left: auto; }
.sx-ch__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-ch__f { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }
.sx-ch__a { display: flex; }
.sx-ch .cmd { background: var(--surface-2); }
.sx-ch--off .sx-ch__h b { color: var(--ink-muted); }
.sx-foot { display: flex; align-items: center; gap: var(--space-3); justify-content: space-between; flex-wrap: wrap; margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.sx-foot p { display: flex; gap: 8px; align-items: flex-start; flex: 1 1 320px; min-width: 0; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-foot p .ic { flex: none; margin-top: 2px; }
.sx-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); align-items: start; }
.sx-form .field { align-content: start; }
.sx-span2 { grid-column: 1 / -1; }
.sx-from { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.sx-from .input { flex: 1 1 180px; width: auto; min-width: 0; }
.sx-from .seg { min-width: 0; max-width: 100%; overflow-x: auto; }
.sx-form .seg { max-width: 100%; overflow-x: auto; justify-self: start; }
#p-sb-new .confirm { margin-top: var(--space-4); }
#p-sb-new .cmd { margin-top: 2px; }
.sx-term { min-width: 0; border-radius: var(--radius-md); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line); overflow: hidden; }
.sx-term__h { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--surface); }
.sx-term__t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 650; }
.sx-term__t span:last-child { font-weight: 500; color: var(--ink-muted); }
.sx-term__c { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ink-muted); }
.sx-term__c > span { display: inline-flex; align-items: center; gap: 5px; }
.sx-rec { margin-left: auto; font-size: 12px; font-weight: 650; color: var(--ok-ink); }
.sx-term__b { margin: 0; padding: 12px 14px; font-family: var(--font-mono); font-size: 12px; line-height: 19px; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; }
.sx-term__b:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.sx-tl { display: block; }
.sx-ps { color: var(--running-ink); font-weight: 650; }
.sx-out { color: var(--ink-muted); }
.sx-cur { display: inline-block; width: 8px; height: 16px; vertical-align: -3px; background: var(--ink); }
.sx-term__f { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); background: var(--surface); }
.sx-term__f span { flex: 1 1 220px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-opens, .sx-kepts { display: grid; gap: 8px; }
.sx-open { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sx-open > .dot { margin-top: 6px; }
.sx-open__t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 650; }
.sx-kind { font-size: 12px; font-weight: 600; color: var(--ink-muted); }
.sx-open__s { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-open__a { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.sx-kept { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.sx-kept--no { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.sx-kept__t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 650; }
.sx-kept__t .muted { font-weight: 500; }
.sx-kept__s { grid-column: 1; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-kept__a { grid-column: 2; grid-row: 1 / span 2; }
.sx-left { white-space: nowrap; color: var(--tone-ink); font-weight: 650; }
.sx-left.tone-idle { color: var(--ink-muted); }
.sx-small { display: flex; gap: 8px; align-items: flex-start; margin-top: var(--space-3); font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.sx-small .ic { flex: none; margin-top: 2px; }
.sx-small .code { white-space: normal; overflow-wrap: anywhere; }
.sx-open__s .ic, .sx-left .ic { vertical-align: -2px; margin-right: 3px; }
.sx-run__s .vtag { margin: 0 2px; }
#p-sb-browser .sx-p { margin-bottom: var(--space-3); }
@media (max-width: 760px) {
  .sx-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .sx-form { grid-template-columns: minmax(0, 1fr); }
  .sx-from { display: grid; grid-template-columns: minmax(0, 1fr); }
  .sx-from .seg { justify-self: start; }
  .sx-term__b { min-height: 0; font-size: 12px; }
}
`;
