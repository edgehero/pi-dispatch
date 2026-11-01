/** Registration metadata stays separate from private host plans; all effects use the common audited pipeline. */
import { SETUP_ACTION_NAMES } from "../setup-actions.mjs";

export const SETUP_HTTP_ACTIONS = SETUP_ACTION_NAMES.map(name => ({
  name, kind: name, paid: false, bulk: false, needs: ["setup"],
  preview(body, ctx) {
    const params = name === "setup-provider-key" ? { value: body.value } : name === "setup-viewer-add" ? { name: body.name } : name === "setup-viewer-revoke" ? { name: body.name, identity: body.identity } : {};
    return ctx.a.setup.preview(name, params, { session: ctx.session });
  },
  apply(entry, ctx) { return ctx.a.setup.apply(name, entry, { session: ctx.session }); },
}));
const stopping = name => name.endsWith("-stop") || name.endsWith("-restart");
const inverse = (name, out, result) => {
  if (name === "setup-viewer-add") return result?.viewer ? { action: "setup-viewer-revoke", body: result.viewer } : null;
  if (name.match(/^setup-(worker|receiver)-(install|start)$/)) return { action: name.replace(/-(install|start)$/, "-stop"), body: {} };
  return null;
};
const undo = name => name === "setup-viewer-add" ? "Revoke the exact viewer entry through a fresh confirmation, or use pi-dispatch-console token revoke on the host."
  : name.match(/^setup-(worker|receiver)-(install|start)$/) ? "Preview Stop separately. SIGTERM can interrupt work, including a job admitted after this preview; stopping does not undo spending or remove the unit."
  : name === "setup-provider-key" ? "Review and remove the key on the host if needed; this page keeps no previous credential. Restarting a worker is a separate confirmed action."
  : name === "setup-egress-start" ? "Use the host terminal to stop the proxy after its workers and attached jobs are stopped; this page cannot prove a destructive stop is safe."
  : name === "setup-doctor" ? "Run doctor again for a newer observation. Its published checks expire; no configuration was changed."
  : name === "setup-viewer-revoke" ? "Create a new viewer invitation to restore access. The old entry and its sessions cannot be restored."
  : "Use the corresponding terminal service command after reviewing the interruption and current workload. Money already spent cannot be undone.";
export const SETUP_WRITE_RULES = Object.fromEntries(SETUP_ACTION_NAMES.map(name => [name, {
  fields: name === "setup-provider-key" ? ["value"] : name === "setup-viewer-add" ? ["name"] : name === "setup-viewer-revoke" ? ["name", "identity"] : [],
  danger: stopping(name) || name === "setup-viewer-revoke", atConfirm: name === "setup-viewer-add",
  undo: () => name.match(/^setup-(worker|receiver)-(install|start)$/) ? { bar: undo(name), after: "Use Stop through a fresh confirmation. SIGTERM can interrupt in-flight or newly admitted work; stopping does not undo spending or remove the unit." } : undo(name), inverse: (out, _body, result) => inverse(name, out, result),
  confirmLabel: () => name === "setup-provider-key" ? "Save key once" : name === "setup-viewer-add" ? "Create viewer invitation" : name === "setup-viewer-revoke" ? "Revoke viewer" : stopping(name) ? "Confirm interruption" : "Confirm setup",
  done: () => name === "setup-provider-key" ? "Saved the provider key; a running worker needs a separate restart" : name === "setup-viewer-add" ? "Created a viewer invitation" : name === "setup-viewer-revoke" ? "Revoked the created viewer entry" : name === "setup-doctor" ? "Ran doctor; readiness follows its published checks" : "Applied host setup; check the live readiness observation",
}]));
