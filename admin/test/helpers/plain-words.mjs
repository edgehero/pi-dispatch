// The words the half of the root README written for someone who does not write code leaves to "For engineers". One list,
// because the README's text and the pictures in it (`explainers.test.mjs`) are read by the same person.
export const TOP_HALF_BANNED = Object.freeze(["Valkey", "BullMQ", "egress", "webhooks?", "rootless", "Quadlet", "CONST-", "REQ-", "DES-", "INT-", "cron", "OCI", "forges?"]);

// Tempting claims that are false, each checked against the code and docs. One list, because the pictures and the film make
// the same promises. `github-host.mjs` only checks that protection exists: a job's token can merge, so branch protection
// is the control (README, GitHub automation). `docs/costs.md` lists what the caps do not cover. Two keys go in and the
// agent can read both. A refusal can keep its job count slot, and the machine costs what it costs. The worker has dozens
// of refusals, so any count of checks is stale the day one is added. An AI reviews and never approves: a self-approval is
// a merge by another name (`CONST-MERGE-NEVER-AUTOMATIC`). pi-dispatch looks after a swarm and does not direct it, so
// "orchestrates" would be another agent it does not have.
export const CLAIMS_REFUTED = Object.freeze([/\b(can ?not|can't|unable to) (merge|accept)/i, /\bcan ?not (pass|exceed|overspend)/i, /\bnever (passes|exceeds|overspends)/i, /nothing (gets|leaves|comes) out/i, /\bfree\b/i, /\b\d+ (checks|gates|limits)\b/i, /never accepted/i, /\b(AI|agent|it) (also )?approves?\b/i, /approved by AI/i, /\borchestrat/i]);
