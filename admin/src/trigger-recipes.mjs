/** #774: recipes are editable form defaults, never trigger authority or a write. */
export const TRIGGER_RECIPES = Object.freeze({
  "label-fix": Object.freeze({ title: "Fix issues labelled pi:fix", description: "A GitHub label runs flow fix", icon: "tag", fields: Object.freeze({ kind: "label", forge: "github", labels: "pi:fix", flow: "fix" }) }),
  "nightly-tidy": Object.freeze({ title: "Tidy a folder every night", description: "A local schedule runs flow tidy", icon: "clock", fields: Object.freeze({ kind: "cron", id: "nightly-tidy", pattern: "0 2 * * *", flow: "tidy" }) }),
  "comment-answer": Object.freeze({ title: "Answer @pi in comments", description: "A comment phrase runs flow fix", icon: "comment", fields: Object.freeze({ kind: "comment", forge: "github", phrase: "@pi", flow: "fix" }) }),
});
