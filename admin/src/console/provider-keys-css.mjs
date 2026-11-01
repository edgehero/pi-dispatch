/** Pasted from design/tools/provider_keys.py; the rendering test pins this exact source. */
export const PROVIDER_KEYS_CSS = `
.pk-intro,.pk-note { font-size: 12px; line-height: 19px; color: var(--ink-muted); }
.pk-intro { margin-bottom: 14px; }
.pk-list { display: grid; gap: 8px; }
.pk-row { display: grid; gap: 7px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); min-width: 0; }
.pk-row__title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.pk-row__title b { font-size: 13px; overflow-wrap: anywhere; }
.pk-row__title .badge { margin-left: auto; }
.pk-key { font-size: 12px; overflow-wrap: anywhere; white-space: normal; }
.pk-editor { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
.pk-editor h3,.pk-help h3 { font-size: 13px; margin: 0 0 10px; }
.pk-form { display: grid; gap: 12px; min-width: 0; }
.pk-form fieldset { display: contents; border: 0; padding: 0; margin: 0; min-width: 0; }
.pk-form .field { min-width: 0; }
.pk-form .input,.pk-form .select { width: 100%; min-width: 0; box-sizing: border-box; }
.pk-picks { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.pk-form .btn { justify-self: start; }
.pk-help { display: grid; gap: 8px; margin-top: 16px; }
.pk-guide { padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-md); min-width: 0; }
.pk-guide summary { cursor: pointer; font-size: 13px; font-weight: 650; color: var(--ink); }
.pk-guide summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.pk-guide[open] summary { margin-bottom: 10px; }
.pk-guide ol { padding-left: 20px; display: grid; gap: 6px; font-size: 12px; line-height: 19px; color: var(--ink-muted); }
.pk-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }
.pk-notice { margin-top: 8px; }
.pk-default { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; margin-bottom: 12px; font-size: 13px; }
.pk-compact { display: grid; gap: 8px; margin-top: 12px; font-size: 12px; line-height: 19px; }
.pk-compact p { color: var(--ink-muted); }
@media (max-width: 760px) { .pk-picks { grid-template-columns: minmax(0, 1fr); } .pk-row__title .badge { margin-left: 0; } .pk-links .btn { max-width: 100%; height: auto; min-height: 32px; white-space: normal; text-align: center; } }
`;
