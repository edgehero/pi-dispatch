/** Page rules copied from the Configuration cards' local layout (#750). */
export const CONFIG_CSS = `
@media(max-width:1100px){.config-layout{grid-template-columns:minmax(0,1fr)!important}.config-layout .facts,.config-layout .facts--3{grid-template-columns:minmax(0,1fr)}.config-layout .fact{grid-template-columns:128px minmax(0,1fr)}.config-layout .config-options{grid-template-columns:minmax(0,1fr)}}
.config-sections{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;align-items:center}
.config-sections>.btn{background:transparent;border:1px solid var(--line-strong)}
.config-divider{height:24px;border-left:1px solid var(--line);margin:0 6px}
.config-form{align-items:stretch;max-width:100%;margin-top:16px}
.config-form .facts{grid-column:1/-1;grid-template-columns:minmax(0,1fr)}
.config-form .field{min-width:0;max-width:100%}
.config-form input,.config-form textarea,.config-form select{box-sizing:border-box;width:100%;min-width:0}
.config-form .btn{align-self:flex-start}
.config-editor{margin-top:14px;min-width:0}
.config-editor>summary{cursor:pointer;color:var(--primary);font-weight:650;margin-bottom:12px}
.config-editor .stack{gap:12px}
.config-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;grid-column:1/-1}
.config-options>.field{padding:12px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface-2)}
@media(max-width:760px){.config-options{grid-template-columns:1fr}}
[data-config-controls]{display:contents!important;border:0!important;padding:0!important;margin:0!important}
.config-form fieldset{border:1px solid var(--line);border-radius:var(--radius-md);min-width:0;padding:16px;display:grid;gap:12px}
.config-form fieldset[hidden]{display:none}
[data-page="config"] section,[data-page="trigger"] section,[data-page="trigger-add"] section{margin-bottom:20px;min-width:0}
[data-page="config"] .card,[data-page="trigger"] .card,[data-page="trigger-add"] .card{overflow-wrap:anywhere}
[data-page="config"] .tbl{min-width:680px;overflow-wrap:normal}
[data-page="config"] .tbl td{min-width:65px}
[data-page="config"] .tbl .config-editor{min-width:220px}
[data-page="config"] .tbl .config-form{min-width:200px}
[data-page="config"] .tbl .acts{display:flex;gap:8px;align-items:center;flex-wrap:nowrap}
[data-page="config"] .tbl .btn{white-space:nowrap}
[data-page="config"] .tbl td:first-child{min-width:40px}
[data-page="trigger"] pre{white-space:pre-wrap;overflow-wrap:anywhere}
@media(min-width:1000px){[data-page="trigger-add"] .config-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}[data-page="trigger-add"] .config-form h3,[data-page="trigger-add"] .config-form fieldset,[data-page="trigger-add"] .config-form>p{grid-column:1/-1}}
`;
