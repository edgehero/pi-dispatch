/** Human descriptions of the existing receiver gates, shared by a trigger's facts and its add preview. */
export function triggerWhoMayFire(trigger) {
  const on = trigger.on ?? trigger;
  const forge = trigger.run?.kind ?? trigger.forge;
  const kind = on.type;
  if (kind === "cron") return "This deployment's scheduler starts it on its schedule; an operator may fire it by hand.";
  if (forge === "gitlab") return "The actor must be a GitLab project member with Developer access (30) or higher, including inherited membership.";
  if (forge === "forgejo") return "The actor must have Forgejo repository owner, admin or write permission.";
  if (forge === "azure") return "The actor must be an Azure DevOps project member admitted by the receiver's membership check.";
  if (kind === "label") return "A collaborator applies the matching issue label; the label event supplies the approval.";
  if (kind === "comment") return "The commenter's GitHub association must be OWNER, MEMBER or COLLABORATOR; the service's own comments are refused.";
  const actions = Array.isArray(on.action) ? on.action : [];
  const gates = [];
  if (kind === "issue" || actions.includes("closed")) gates.push("The closer must have repository write access");
  if (actions.includes("labeled")) gates.push("A collaborator-applied matching label supplies approval");
  if (actions.includes("review_submitted")) gates.push("The reviewer's association must be OWNER, MEMBER or COLLABORATOR, regardless of the pull request author's association");
  if (actions.some((a) => ["opened", "synchronize", "reopened"].includes(a))) gates.push("The pull request author's association must be OWNER, MEMBER or COLLABORATOR");
  return `${gates.join(". ") || "The receiver checks the actor's authority for the configured event"}.`;
}
