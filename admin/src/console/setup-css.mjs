/** SetupScreen rules, pasted from gen_access.py; shared tokens remain the design system’s. */
export const SETUP_CSS = `
.su-prog { display: grid; gap: 10px; padding: var(--space-4) var(--space-5); margin-bottom: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.su-prog p { font-size: 14px; color: var(--ink-muted); }
.su-prog p b { color: var(--ink); }
.su-big { font-size: 40px; line-height: 44px; font-weight: 800; letter-spacing: -0.02em; margin-right: 4px; font-variant-numeric: tabular-nums; }
.su-bar { width: 100%; display: block; overflow: visible; }
.su-seg { fill: var(--tone); }
.su-seg--todo { fill: var(--surface-3); }
.su-done { display: grid; gap: 6px; margin-bottom: var(--space-4); }
.su-done li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; color: var(--ink-muted); }
.su-done b { color: var(--ink); }
.su-done__act { grid-template-columns: auto minmax(0, 1fr) !important; padding-left: 38px; }
.su-steps { display: grid; gap: 8px; }
.su-step { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-4); padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.su-step__b { display: grid; gap: 10px; min-width: 0; }
.su-step__t { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 15px; font-weight: 700; }
.su-step__t .chip, .su-step__t .su-opt { margin-left: auto; }
.su-opt { font-size: 12px; font-weight: 600; color: var(--ink-muted); }
.su-n { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--surface); color: var(--ink-muted); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.su-step__s { font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.su-step__s b { color: var(--ink); }
.su-act { display: flex; gap: 8px; flex-wrap: wrap; }
.su-small { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.su-small .ic { flex: none; margin-top: 2px; }
.su-prog2 { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface); }
.su-prog2 li { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.su-prog2 li .code { white-space: normal; overflow-wrap: anywhere; }
.su-prog2 .is-done .ic { color: var(--ok-ink); }
.su-prog2 .is-now { color: var(--running-ink); font-weight: 650; }
.su-term summary { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--ink-muted); cursor: pointer; }
.su-term .cmd { margin-top: 8px; background: var(--surface); }
.su-chs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.su-chs--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.su-ch { position: relative; display: grid; align-content: start; gap: 6px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); text-decoration: none; color: inherit; cursor: pointer; }
.su-ch input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.su-ch--on { box-shadow: inset 0 0 0 2px var(--primary); }
.su-ch:focus-within, .su-ch--link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.su-ch__h { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
.su-ch__s { font-size: 12px; line-height: 18px; color: var(--ink-muted); }
.su-ch__f .input { width: 100%; margin-top: 4px; }
.su-rec { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.su-r { display: grid; align-content: start; gap: 6px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); text-decoration: none; color: var(--ink); }
.su-r .tile { background: var(--surface-2); color: var(--ink); }
.su-r b { font-size: 13px; }
.su-r span:last-child { font-size: 12px; color: var(--ink-muted); }
.su-p { font-size: 13px; margin-bottom: var(--space-3); }
.su-p2 { margin-top: var(--space-3); }
#p-setup-ready .su-done { margin-bottom: 0; }
@media (max-width: 760px) { .su-step { grid-template-columns: minmax(0, 1fr); gap: 10px; } .su-step__t .chip, .su-step__t .su-opt { margin-left: 0; } .su-chs, .su-chs--3, .su-rec { grid-template-columns: minmax(0, 1fr); } .su-done li { grid-template-columns: auto minmax(0, 1fr); } .su-done li > span:last-child { grid-column: 2; } .su-done__act { padding-left: 0; } }
.setup-layout .su-step__s .code,.setup-layout .su-done .code{white-space:normal;overflow-wrap:anywhere}
.setup-layout .su-step__b,.setup-layout .su-done li{min-width:0}
.setup-layout .su-done li>details{grid-column:2 / -1}
.setup-layout .su-act .act{max-width:100%}
.setup-layout .su-step__t .chip{max-width:100%;height:auto;white-space:normal}
.setup-layout .config-form fieldset{min-width:0}
.setup-layout .su-step__s,.setup-layout .su-done span{overflow-wrap:anywhere}
.setup-layout .su-r:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

`;
