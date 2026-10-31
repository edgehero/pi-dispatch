import { html } from "../html.mjs";
import * as ui from "../kit.mjs";

export const AGENT_WRITES_UNAVAILABLE = "Agent writes today could not be verified from this console host's audit log. This is not a zero.";
export function overviewAgentWrites(view) {
  if (view.role !== "operator") return html``;
  const data = view.data?.agentWrites;
  if (!data) return html``;
  const exact = Number.isSafeInteger(data.count) && data.count >= 0 && !data.unavailable;
  return ui.card({ title: "Agent writes today", sub: `${data.host ?? "This console host"}, UTC today; local audit only`, body: html`${exact ? ui.kpi(`${data.partial ? "at least " : ""}${data.count}`, "confirmed applied writes") : html`<p>${AGENT_WRITES_UNAVAILABLE}</p>`}${data.partial && exact ? html`<p class="card__sub">The read is partial or some audited intentions have no applied receipt. No wider total is inferred.</p>` : null}<a class="link" href="${"/audit?role=agent&action=write-applied"}">Open this host's agent audit history</a><p class="card__sub">The history link also includes earlier days. Every inverse still follows its current permission and confirmation rules.</p>` });
}
