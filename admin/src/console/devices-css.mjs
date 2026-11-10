/** Remembered browsers (issue #849, the DevicesScreen card) and the sign-in form's Remember box. A browser's label and id stack in one cell, and a phone stacks the rows. */
export const DEVICES_CSS = `
.signin__remember{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:18px;cursor:pointer}
.signin__remember input{flex:none;width:16px;height:16px;margin-top:1px;accent-color:var(--ink)}
.signin__remember span{display:grid;gap:2px;min-width:0}
.signin__remember b{font-weight:650}
.signin__remember small{color:var(--ink-muted)}
.dev-what,.dev-who{display:grid;gap:2px;min-width:0}
.dev-what b,.dev-who b{font-weight:650;overflow-wrap:anywhere}
.dev-what small,.dev-who small{font-size:12px;color:var(--ink-muted)}
.dev-what .chip{justify-self:start}
.dev-act{text-align:right;white-space:nowrap}
.dev-act .act{display:inline-flex}
.dev-note{padding:0 var(--space-5) var(--space-3);margin:0}
.dev-foot{display:flex;gap:8px;align-items:flex-start;padding:var(--space-3) var(--space-5) var(--space-4);font-size:12px;line-height:18px;color:var(--ink-muted);border-top:1px solid var(--line)}
.dev-foot .ic{flex:none;margin-top:2px}
@media (max-width:760px){.dev-act{text-align:left}}
.who--remembered .avatar{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--ink)}
`;
