/** SecretsScreen's source-card geometry, scoped to its page (#751). */
export const SECRETS_CSS = `
body[data-page="secrets"] .secret-cell { display: grid; gap: 3px; min-width: 0; }
body[data-page="secrets"] .secret-cell small, body[data-page="secrets"] .secret-resolvers small { font-size: 12px; line-height: 16px; color: var(--ink-muted); }
body[data-page="secrets"] .secret-state { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--tone-ink); font-weight: 550; line-height: 18px; max-width: 260px; }
body[data-page="secrets"] .secret-state .ic { flex: none; margin-top: 2px; }
body[data-page="secrets"] .secret-state span { min-width: 0; }
body[data-page="secrets"] .tbl td { vertical-align: top; }
body[data-page="secrets"] .tbl td.id { min-width: 96px; }
body[data-page="secrets"] .tbl .code { white-space: normal; overflow-wrap: anywhere; }
body[data-page="secrets"] .tbl td.id .code { white-space: nowrap; overflow-wrap: normal; }
/* Keep clipped contextual labels in their button's containing block; a body-positioned 1px label can still widen
   the viewport when its table scrolls, even though the table and every visible box fit. */
body[data-page="secrets"] .btn { position: relative; }
body[data-page="secrets"] .secret-refusal { color: var(--failed-ink); }
body[data-page="secrets"] .secret-note { padding: 0 var(--space-5) var(--space-3); font-size: 13px; color: var(--ink-muted); }
body[data-page="secrets"] .secret-resolvers { padding: 0 var(--space-5) var(--space-3); display: flex; flex-wrap: wrap; gap: 12px 24px; }
body[data-page="secrets"] .secret-resolvers li { display: grid; align-content: start; gap: 4px; min-width: 0; max-width: 320px; }
body[data-page="secrets"] .secret-names { display: flex; flex-wrap: wrap; gap: 4px; }
body[data-page="secrets"] .secret-names .code { padding: 1px 6px; border-radius: 6px; background: var(--surface-2); font-size: 12px; }
body[data-page="secrets"] .config-form { display: grid; gap: var(--space-3); }
body[data-page="secrets"] .config-form fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: var(--space-3); min-width: 0; }
body[data-page="secrets"] .config-form label { display: grid; gap: 6px; }
body[data-page="secrets"] .config-form [type="submit"] { justify-self: start; }
body[data-page="secrets"] #p-secret-add .config-form { max-width: 640px; }
body[data-page="secrets"] .field__err { color: var(--failed-ink); font-size: 13px; }
body[data-page="secrets"] .field--err .input { box-shadow: inset 0 0 0 1.5px var(--failed); }
body[data-page="secrets"] .secret-help { display: grid; gap: 16px; margin: 0 0 16px; }
body[data-page="secrets"] .secret-help dt { font-weight: 650; margin-bottom: 4px; }
body[data-page="secrets"] .secret-help dd { margin: 0; color: var(--ink-muted); }
body[data-page="secrets"] .card__head .end { max-width: 360px; text-align: right; }
@media (max-width: 760px) {
 body[data-page="secrets"] .secret-state { max-width: none; }
 body[data-page="secrets"] .secret-note, body[data-page="secrets"] .secret-resolvers { padding-left: var(--space-4); padding-right: var(--space-4); }
 body[data-page="secrets"] .card__head .end { margin-left: 0; max-width: none; text-align: left; }
 body[data-page="secrets"] .tbl--stack tr.row--failed { background: var(--failed-tint); }
 body[data-page="secrets"] .tbl--stack tr.row--attention { background: var(--attention-tint); }
 body[data-page="secrets"] .tbl--stack tr.row--failed td, body[data-page="secrets"] .tbl--stack tr.row--attention td { background: transparent; }
}
`;
