/** Page-local Pulse rules copied from the published FleetScreen and FleetPartPaused generators. */
export const FLEET_DESIGN_CSS = `
.fl-bar { display: grid; gap: var(--space-4); }
.fl-bar__row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.fl-bar__t { min-width: 0; }
.fl-bar__t h2 { font-size: 20px; line-height: 26px; font-weight: 750; }
.fl-bar__t .muted { font-size: 13px; }
.fl-bar__stats { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.fl-bar__stats > span { display: inline-flex; align-items: baseline; gap: 5px; height: 34px; padding: 0 14px; align-items: center; border-radius: var(--radius-pill); background: var(--surface-2); font-size: 13px; color: var(--ink-muted); }
.fl-bar__stats b { color: var(--ink); font-size: 15px; }
.fl-bar__stats .tinted b { color: var(--failed-ink); }
.fl-prog { display: grid; gap: 4px; min-width: 190px; }
.fl-prog .reason { margin-top: 0; }
.fl-orphan td { background: var(--attention-tint); }
.tbl tbody tr.fl-orphan:hover td { background: var(--attention-tint); }
.fl-held { display: grid; gap: 8px; padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); }
.fl-held__h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.fl-held__h .end { margin-left: auto; }
.fl-cond { display: grid; gap: 4px; }
.fl-cond li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; background: var(--surface); font-size: 13px; }
.fl-cond li > .ic { color: var(--ink-muted); }
.fl-cond li > span:nth-child(2) { display: flex; flex-direction: column; line-height: 18px; }
.fl-cond .muted { font-size: 12px; }
.hostrow__x { min-width: 0; }
.hostrow__x > .fl-res, .fl-res { flex: 1 1 100%; min-width: 0; display: grid; grid-template-columns: 64px minmax(0, 1fr) 112px; align-items: center; gap: 10px; }
.fl-res__l { color: var(--ink-muted); }
.fl-res__v { color: var(--ink); font-weight: 600; white-space: nowrap; text-align: right; }
.fl-doc { display: grid; gap: 8px; padding-top: var(--space-3); margin-top: var(--space-3); border-top: 1px solid var(--line); }
.fl-doc:first-of-type { padding-top: 0; margin-top: 0; border-top: 0; }
.fl-doc__h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 14px; }
.fl-doc__p { font-size: 13px; }
.fl-cnt { display: inline-flex; gap: 12px; font-size: 12px; }
.fl-cnt > span { display: inline-flex; align-items: center; gap: 4px; }
.fl-chks { display: grid; gap: 4px; }
.fl-chk { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 4px 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.fl-chk .code { font-size: 12px; color: var(--ink-muted); }
.fl-chk__said { min-width: 0; }
.fl-chk__fix { grid-column: 1 / -1; color: var(--ink-muted); font-size: 12px; }
.fl-chk__fix b { color: var(--ink); }
.fl-asserted { background: var(--surface-2); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong); }
.fl-absent { background: transparent; color: var(--ink-faint); box-shadow: none; border: 1px dashed var(--line); }
.fl-vfoot { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; padding: var(--space-3) var(--space-5) var(--space-4); border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-muted); }
.fl-vfoot > span { display: inline-flex; align-items: center; gap: 6px; }
.fl-floor { margin-left: 0; }
.fl-why { display: block; max-width: 420px; }
@media (max-width: 760px) { .fl-bar__stats { margin-left: 0; } .fl-floor { margin-left: 0; } .hostrow__x > .fl-res { grid-template-columns: 56px minmax(0, 1fr) auto; } }


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

.pp-refusal { display: grid; gap: 10px; padding: 14px 16px; border-radius: var(--radius-md); background: var(--tone-tint); color: var(--ink); font-size: 13px; line-height: 20px; }
.pp-refusal__h { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--tone-ink); font-size: 14px; }
.pp-refusal__h .ic { width: 18px; height: 18px; }
.pp-refusal .cmd { background: var(--surface); }
.pp-refusal__f { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pp-refusal__f .btn { margin-left: auto; }
.pp-src { display: flex; align-items: flex-start; gap: 6px; line-height: 17px; font-size: 12px; color: var(--ink-muted); }
.pp-foot { padding: var(--space-3) var(--space-5) var(--space-4); border-top: 1px solid var(--line); font-size: 12px; line-height: 17px; color: var(--ink-muted); }
.pp-bulk { border-top: 1px solid var(--line); padding-top: var(--space-4); }
.pp-bulk__row { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; }
.pp-bulk__row .field { flex: 1 1 180px; }
.pp-bulk__b { display: flex; gap: 8px; flex-wrap: wrap; }
.pp-why { border-top: 1px solid var(--line); padding-top: var(--space-4); display: grid; gap: 6px; }
.pp-why .sect-h { margin: 0 0 4px; }
.pp-why details { border-radius: 12px; background: var(--surface-2); padding: 8px 12px; font-size: 13px; }
.pp-why summary { cursor: pointer; }
.pp-pre { margin: 8px 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 12px; line-height: 18px; color: var(--ink); }
.pp-wb-hold { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; stroke-dasharray: 5 4; }
.pp-wrap { white-space: normal; min-width: 220px; }
.pp-legend { margin-top: var(--space-4); }
.pp-what { margin-top: var(--space-4); padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; }
.pp-what summary { cursor: pointer; font-weight: 650; }
.pp-what .mini-list { margin-top: 10px; }
.pp-waiter { display: flex; gap: 8px; align-items: center; margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--line); font-size: 13px; }
.pp-sts { display: grid; gap: 8px; }
.pp-st { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); }
.pp-st .tile { background: var(--tone-tint); color: var(--tone-ink); }
.pp-st__t { font-size: 13px; font-weight: 700; }
.pp-st__s { font-size: 12px; line-height: 17px; color: var(--ink-muted); margin-top: 2px; }
.pp-st .btn { margin-top: 8px; }
.pp-res { display: grid; gap: 4px; }
.pp-res > span { display: flex; gap: 6px; align-items: flex-start; }
.pp-res .ic { margin-top: 1px; flex: none; }
.pp-res b { color: var(--ink); }
@media (max-width: 760px) { .confirm__act .btn { white-space: normal; height: auto; min-height: 40px; padding-top: 8px; padding-bottom: 8px; text-align: center; } .pp-src .code { white-space: normal; overflow-wrap: anywhere; } .pp-foot { padding: var(--space-3) var(--space-4); } .pp-refusal__f .btn { margin-left: 0; } }

/* Phase helpers replace the sample's single bar; their children must stay within their cell. */
#p-active .fl-prog > .phases { min-width: 0; max-width: 100%; margin: 0; padding: 0; list-style: none; }
@media (max-width: 760px) {
  #p-active .tbl--stack td[data-l="Progress"] { grid-column: 1 / -1; min-width: 0; }
  #p-active .tbl--stack td[data-l="Progress"] + td { grid-column: 1 / -1; justify-self: end; }
  #p-active .fl-prog { min-width: 0; max-width: 100%; width: 100%; }
}
`;
