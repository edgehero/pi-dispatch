/** ModelsScreen's page rules, from design/tools/gen_spend.py (#773), adapted to the shared responsive table kit. */
export const MODELS_CSS = `
.models-layout { grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr); }
.models-layout > *, .models-layout .stack, #p-roles .tbl-wrap { min-width: 0; }
#p-roles .md-ref, #p-cooldowns .md-ref, #p-models .md-ref, #p-proposals .md-ref { white-space: normal; overflow-wrap: anywhere; }
#p-roles .tbl { table-layout: fixed; width: 100%; }
#p-roles .tbl td, #p-roles .tbl th { overflow-wrap: anywhere; vertical-align: top; }
#p-roles .tbl td:last-child { min-width: 0; }
.md-scope { display: block; color: var(--ink-muted); margin-top: 4px; }
.md-fallbacks { padding-left: 18px; display: grid; gap: 7px; }
.md-trigger-list, .md-ms, .md-proposals, .md-sources, .md-waiting { list-style: none; padding: 0; display: grid; gap: 10px; }
.md-foot { margin-top: 12px; color: var(--ink-muted); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
#p-roles .md-foot, #p-roles .md-add { margin: 14px 20px; }
.md-editor { min-width: 0; }
.md-editor summary { cursor: pointer; overflow-wrap: anywhere; }
.md-editor[open] { margin-top: 10px; }
.md-form { display: block; margin-top: 14px; min-width: 0; }
.md-form fieldset { display: grid; gap: 14px; min-width: 0; border: 0; padding: 0; }
.md-form .input, .md-form .select { width: 100%; min-width: 0; }
.md-form .btn { justify-self: start; }
.md-role-editor { margin: 14px 20px; border-top: 1px solid var(--line); padding-top: 12px; }
.md-role-editor .md-form fieldset { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.md-role-editor .md-fixed { grid-column: 1 / -1; }
.md-remove { margin-top: 12px; }
.md-remove fieldset { border: 0; padding: 0; min-width: 0; }
.md-remove .btn { max-width: 100%; min-width: 0; height: auto; min-height: 30px; padding: 6px 13px; white-space: normal; overflow-wrap: anywhere; line-height: 18px; }
.md-fixed { overflow-wrap: anywhere; }
.md-m { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border-radius: var(--radius-md); background: var(--surface-2); flex-wrap: wrap; }
.md-m__t { flex: 1; min-width: min(180px, 100%); }
.md-m__t small { display: block; color: var(--ink-muted); margin-top: 6px; font-size: 12px; }
.md-windows { margin-top: 8px; padding-left: 16px; color: var(--ink-muted); font-size: 12px; overflow-wrap: anywhere; }
.md-cool { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.md-cool > div { min-width: 0; }
.md-next { list-style: none; padding: 0; display: grid; gap: 12px; margin-top: 18px; }
.md-next li { border-top: 1px solid var(--line); padding-top: 12px; overflow-wrap: anywhere; }
.md-next p { font-size: 13px; margin-top: 5px; color: var(--ink-muted); }
.md-note { margin-top: 14px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; overflow-wrap: anywhere; }
.md-proposals li { padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.md-proposals p + p { margin-top: 6px; }
.md-prop { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--line); min-width: 0; }
.md-prop h3 { font-size: 17px; line-height: 24px; overflow-wrap: anywhere; }
.md-prop .tbl-wrap { margin-top: 14px; }
.md-sources { margin-top: 14px; font-size: 13px; overflow-wrap: anywhere; }
.md-adopt { margin-top: 18px; }
.md-adopt .md-form fieldset { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.md-adopt .md-form .btn { align-self: end; }
.md-run-more { margin-top: 20px; margin-bottom: 10px; font-size: 14px; }
@media (max-width: 1100px) { .models-layout { grid-template-columns: minmax(0, 1fr); } }
/* The shared two-track stack lets a long model starve the role and fallback cells.
   Models needs one full-width field per row, with its label on a separate line. */
@media (max-width: 760px) {
  #p-roles .tbl--stack tr, #p-proposals .tbl--stack tr { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  #p-roles .tbl--stack td, #p-proposals .tbl--stack td { width: 100%; min-width: 0; }
  #p-roles .tbl--stack td[data-l]::before, #p-proposals .tbl--stack td[data-l]::before { display: block; margin-bottom: 5px; line-height: 16px; }
  #p-roles .md-fallbacks { margin: 0; }
}
@media (max-width: 760px) { #p-roles .tbl { table-layout: auto; } .md-adopt .md-form fieldset, .md-role-editor .md-form fieldset { grid-template-columns: minmax(0, 1fr); } #p-roles .md-editor .md-form { max-width: 100%; } }
`;
