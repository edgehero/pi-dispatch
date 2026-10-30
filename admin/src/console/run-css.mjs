/** Run cards and the browser-owned transcript slots (#747), scoped to the run page by page-css.mjs. */
import { QCARD_CSS } from "./parked-css.mjs";
export const RUN_CSS = `${QCARD_CSS}
/* Keep fact values readable inside a narrow desktop card as well as on a phone. */
.facts, .facts--3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.facts--1 { grid-template-columns: minmax(0, 1fr); }
.fact { grid-template-columns: minmax(0, min(128px, 40%)) minmax(0, 1fr); }
.titlebar h1 { overflow-wrap: anywhere; word-break: break-word; font-family: var(--font-mono); font-size: 26px; }
.titlebar__sub [data-panel] { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.titlebar__sub .act { margin-left: auto; }
.card { min-width: 0; }
.banner { min-width: 0; grid-template-columns: auto minmax(0, 1fr); }
.banner__act { grid-column: 1 / -1; min-width: 0; max-width: 100%; flex-wrap: wrap; }
.banner__act > * { min-width: 0; max-width: 100%; }
.banner__act form.act { margin: 0; }
.banner__act .card__sub { flex-basis: 100%; overflow-wrap: anywhere; }
.banner__act .btn { height: auto; min-height: 38px; white-space: normal; overflow-wrap: anywhere; text-align: center; }
.card h3 { margin: 18px 0 8px; font-size: 14px; }
.card p { overflow-wrap: anywhere; }
.card .note, .card .card__sub { color: var(--ink-muted); }
.card .warn { color: var(--attention-ink); }
.card pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.card .fact dt { min-width: 0; overflow-wrap: anywhere; }
.card .mono { font-family: var(--font-mono); overflow-wrap: anywhere; }
.card .plain { list-style: none; padding: 0; }
.card .scroll { max-width: 100%; overflow-x: auto; }
.card .grid { font-size: 12px; }
.card .table-wrap { max-width: 100%; overflow-x: auto; }
.card table { width: 100%; border-collapse: collapse; font-size: 12px; }
.card th, .card td { padding: 8px; border-bottom: 1px solid var(--line); text-align: left; overflow-wrap: anywhere; }
.card form.act { display: block; margin-top: 10px; }
.card textarea { width: 100%; min-height: 90px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink); padding: 10px; }
.card button { max-width: 100%; }
.phases { list-style: none; padding: 0; }
.tx__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 12px; }
.tx { max-height: 70vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.tx__e { min-width: 0; }
.tx__e [hidden] { display: none; }
.tx__e pre { white-space: pre-wrap; }
[data-run-question] { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 18px; line-height: 1.5; }
[data-run-tail] .tx__e { grid-template-columns: minmax(0, 1fr); margin-bottom: 8px; }
[data-run-tail] .tx__t { text-align: left; }
.run-track { overflow-x: auto; max-width: 100%; }
.run-track svg { display: block; min-width: 500px; width: 100%; }
.run-track text { fill: var(--ink); font-size: 13px; font-family: var(--font-mono); }
.run-track__line { stroke: var(--line); }
.run-track__attempt { fill: var(--failed-tint); stroke: var(--failed); }
.run-track__next { fill: var(--running-tint); stroke: var(--running); }
.run-track__wait { stroke: var(--ink-muted); stroke-dasharray: 3 4; }
.run-cp circle { fill: var(--running); }
.run-cp--failed circle { fill: var(--failed); }
.run-cp--skipped circle { fill: var(--surface); stroke: var(--ink-muted); }
#p-transcript:empty + #transcript { display: none; }
.run-note { white-space: pre-wrap; }
@media (max-width: 640px) { .titlebar h1 { font-size: 20px; } .card th, .card td { padding: 5px; } }
`;
