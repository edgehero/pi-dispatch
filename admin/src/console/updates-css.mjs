/** Updates keeps the card's own columns: what jobs run beside how it keeps up. Long names and version pairs stay inside their cells, and a phone stacks them. */
export const UPDATES_CSS = `
.updates-layout{grid-template-columns:minmax(0,2fr) minmax(260px,1fr)}
.up-what{display:grid;gap:2px;min-width:0}
.up-what b{font-weight:650;overflow-wrap:anywhere}
.up-what span{font-size:12px;color:var(--ink-muted)}
.up-ver{white-space:nowrap;font-family:var(--font-mono);font-size:13px}
.up-ver .ic{vertical-align:-2px;margin:0 4px;color:var(--ink-faint)}
.up-line{font-size:13px;line-height:20px;min-width:220px}
.up-line p{margin:0}
.up-line .up-hosts{margin:6px 0 0;padding:0;list-style:none;font-size:12px;color:var(--ink-muted)}
.up-line .up-excerpt{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--ink-muted);white-space:pre-wrap;overflow-wrap:anywhere;max-height:9em;overflow:auto}
.up-act{text-align:right;white-space:nowrap}
.up-act .config-form{display:flex;flex-direction:column;align-items:flex-end;gap:6px;width:max-content;max-width:100%;margin:0 0 0 auto}
.up-act .config-form+.config-form{margin-top:6px}
.up-act select{max-width:220px}
.up-recent{display:grid;gap:2px;min-width:0;overflow-wrap:anywhere}
.up-recent small{font-size:12px;color:var(--ink-muted)}
#p-up-recent .rowpill{padding-top:8px;padding-bottom:8px;padding-right:12px;border-radius:var(--radius-md)}
.up-foot{display:flex;gap:8px;align-items:flex-start;padding:var(--space-3) var(--space-5) var(--space-4);font-size:12px;line-height:18px;color:var(--ink-muted);border-top:1px solid var(--line)}
.up-foot .ic{flex:none;margin-top:2px}
@media (max-width:1180px){.updates-layout{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){.up-line{min-width:0}.up-act{text-align:left;white-space:normal}.up-act .config-form{align-items:flex-start;margin-left:0}}
`;
