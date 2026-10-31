/** Pasted local card rules from design/tools/subscription_auth.py (#781). */
export const SUBSCRIPTION_AUTH_CSS = `
.sa-accounts { display: grid; gap: var(--space-5); }
.sa-account { min-width: 0; }
.sa-account + .sa-account { padding-top: var(--space-4); border-top: 1px solid var(--line); }
.sa-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.sa-title h3 { margin: 0; font-size: 15px; }
.sa-facts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 8px 14px; font-size: 13px; line-height: 20px; }
.sa-facts dt { color: var(--ink-muted); }
.sa-facts .badge { max-width: 100%; height: auto; min-height: 24px; padding-top: 3px; padding-bottom: 3px; white-space: normal; line-height: 18px; align-items: flex-start; }
.sa-facts .badge .ic { margin-top: 2px; }
.sa-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.sa-account .code, .sa-account code { white-space: normal; overflow-wrap: anywhere; }
.sa-note { margin-top: 12px; color: var(--ink-muted); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
.sa-commands { margin-top: 16px; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.sa-commands > * { min-width: 0; max-width: 100%; }
.sa-commands .cmd { min-width: 0; }
.sa-commands .cmd code { overflow-wrap: anywhere; white-space: normal; }
.sa-windows { list-style: none; padding: 0; display: grid; gap: 10px; margin-top: 12px; }
.sa-window { padding: 12px; background: var(--surface-2); border-radius: var(--radius-md); min-width: 0; }
.sa-window b { display: block; margin-bottom: 5px; }
@media (max-width: 600px) {
  .sa-facts { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .sa-facts dd { margin-bottom: 8px; }
}
`;
