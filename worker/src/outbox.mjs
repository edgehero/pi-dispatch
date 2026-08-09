import * as nodeFs from "node:fs";
import { join } from "node:path";
import { readFlowGate as realReadFlowGate } from "./flow-gate.mjs";
import { chainedJobId } from "./job-id.mjs";
import { enqueueLocalJob } from "./queue.mjs";

/**
 * The outbox chain collector: the host-side reader of a completed LOCAL parent's `/outbox`, the
 * container's ONLY signal channel back to the worker (INT-OUTBOX-CONTRACT, DES-JOB-OUTBOX-CHAINING).
 * The worker is the only enqueuer; the container never learns the queue exists. Every field in a
 * `request-<n>.json` is agent-authored and untrusted, so each is allowlist-validated host-side before
 * a child is enqueued, the child folder is FORCED to the parent's own folder (the outbox `folder`
 * field is ignored -- same-folder-only), and depth is HOST-computed, never read from the outbox.
 *
 * Fault isolation is the whole contract. The parent has already COMPLETED its own result before this
 * runs; a throw here would flip a completed parent to failed/retryable and pay TWICE for one answer
 * (CONST-RETRY-INFRA-ONLY). Therefore the entire body is wrapped in one try/catch and `collectChain`
 * NEVER throws: any internal error is logged and the running `{ enqueued, refused }` counts are
 * returned. This is a PRODUCER-only path -- no budget reserve, no container -- and the enqueued
 * children pass `reserveBudget` consumer-side like any local job (CONST-BUDGET-BEFORE-TOKENS).
 *
 * Logs are PII-free by construction: every line carries `{ jobId, reason, index }` only, never the
 * agent-authored `task`/`flow` content or file bytes (`no-pii-in-logs`). The `task` text is DATA that
 * reaches the child's prompt.md but never a log line or the run-history record.
 */

// The skill-name charset: lowercase kebab/underscore, 1-64 chars, no dots (so no "..") and no
// slashes. Mirrors flow-gate.mjs / materialize.mjs SKILL_NAME_RE -- keep in sync. Rejecting a bad
// `flow` here, BEFORE the gate, is the traversal choke point: an untrusted name never reaches git.
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

// One request file: `request-<n>.json`. The captured `<n>` orders the files numerically so the count
// cap deterministically keeps the lowest-numbered requests.
const REQUEST_RE = /^request-(\d+)\.json$/;

// Per-file size cap (4 KiB), enforced BEFORE any read so a hostile file cannot inflate parse cost.
const MAX_REQUEST_BYTES = 4096;

export function makeCollectChain({ queue, enqueue = enqueueLocalJob, readFlowGate = realReadFlowGate, config, fs = nodeFs, log = () => {} }) {
	return async function collectChain({ job, prepared }) {
		let enqueued = 0;
		let refused = 0;
		const refuse = (reason, index) => {
			refused++;
			log(reason, { jobId: job?.id, reason, index });
		};

		try {
			// Belt-and-suspenders: a github parent has no /outbox mount at all (the request channel does not
			// exist for it), but guard here too so a stray dir cannot chain off an untrusted issue author.
			if (job?.data?.kind !== "local") return { enqueued: 0, refused: 0 };

			const outboxDir = join(prepared.jobDir, "outbox");
			let names;
			try {
				names = fs.readdirSync(outboxDir);
			} catch {
				return { enqueued: 0, refused: 0 }; // no outbox dir is the normal no-request case
			}

			const requests = names
				.map((name) => {
					const m = REQUEST_RE.exec(name);
					return m ? { name, n: Number(m[1]) } : null;
				})
				.filter((r) => r !== null)
				.sort((a, b) => a.n - b.n);

			// Depth is host-computed from the parent's own chainDepth, NEVER read from the outbox. A
			// chainDepthMax of 0 is the kill-switch: childDepth is always >= 1, so every request refuses.
			const childDepth = (job.data.chainDepth ?? 0) + 1;

			for (let i = 0; i < requests.length; i++) {
				// Count cap first: only the lowest-numbered `chainMaxPerJob` files are ever read, so parse
				// cost is bounded before any file is opened.
				if (i >= config.chainMaxPerJob) {
					refuse("chain-count-cap", i);
					continue;
				}

				const filePath = join(outboxDir, requests[i].name);

				// Size cap before reading/parsing.
				let size;
				try {
					size = fs.statSync(filePath).size;
				} catch {
					refuse("chain-not-regular-file", i);
					continue;
				}
				if (size > MAX_REQUEST_BYTES) {
					refuse("chain-oversize", i);
					continue;
				}

				// Regular-file-only: lstat (NOT stat) so a symlink is rejected on its own inode, not followed.
				let isFile;
				try {
					isFile = fs.lstatSync(filePath).isFile();
				} catch {
					refuse("chain-not-regular-file", i);
					continue;
				}
				if (!isFile) {
					refuse("chain-not-regular-file", i);
					continue;
				}

				// Read + JSON parse + object-root check.
				let req;
				try {
					req = JSON.parse(fs.readFileSync(filePath, "utf8"));
				} catch {
					refuse("chain-parse-error", i);
					continue;
				}
				if (typeof req !== "object" || req === null || Array.isArray(req)) {
					refuse("chain-parse-error", i);
					continue;
				}

				// Explicit property reads ONLY -- `req` is never spread into job data.
				const flow = req.flow;
				const task = req.task;

				// Flow-name charset, BEFORE the gate: a bad name never reaches git.
				if (typeof flow !== "string" || !SKILL_NAME_RE.test(flow)) {
					refuse("chain-bad-flow-name", i);
					continue;
				}

				// Host-computed depth cap.
				if (childDepth > config.chainDepthMax) {
					refuse("chain-depth-cap", i);
					continue;
				}

				// ai-trigger gate at the parent's pre-agent SHA: only an exact `allow` passes.
				const { gate } = await readFlowGate({ folder: prepared.workspace, flow, sha: prepared.sha });
				if (gate !== "allow") {
					refuse("chain-gate-deny", i);
					continue;
				}

				// Enqueue an ordinary local job on the parent's OWN folder (folder is forced, not read from
				// the outbox). The child id is retry-idempotent so a retried parent dedups instead of fanning out.
				await enqueue(queue, {
					folder: prepared.workspace,
					flow,
					task,
					// The child runs the parent's OWN folder, so it needs the parent's toolchain by definition -- and
					// this is where `image` differs from provider/model, which are deliberately NOT inherited. A
					// fallback provider still runs the flow; a fallback IMAGE gives a child that cannot find its tools,
					// writes a plausible report and exits 0, which is the queue-reports-success failure class arriving
					// by the back door. Read off `job.data` -- the parent's own validated job data -- and NEVER off
					// `req`: the agent cannot choose its child's image any more than it can choose its folder or depth
					// (INT-OUTBOX-CONTRACT's explicit-property-reads rule). Undefined stays undefined, so a parent with
					// no image chains a child whose data is byte-identical to today's.
					image: job.data?.image,
					// The parent's injected skills follow the child, off validated JOB DATA and never off the
					// request file (REQ-PER-TRIGGER-SKILLS). Same reason `image` does: a chained child runs the
					// same operator's flows and, without them, would look up a skill that is not there, write a
					// plausible report and exit 0. It is NOT part of chainedJobId, for the reason stated below.
					skillsDir: job.data?.skillsDir,
					chainDepth: childDepth,
					parentJobId: job.id,
					// chainedJobId deliberately does NOT take the image: the child's identity is (parent, flow, task).
					// Folding the image in would let an operator's triggers.json edit fan out a duplicate paid child
					// from a retried parent. The image is derived from the parent's own data, so it is already stable
					// across that parent's retries.
					jobId: chainedJobId({ parentJobId: job.id, flow, task }),
				});
				enqueued++;
				log("chain-enqueued", { jobId: job.id, reason: "chain-enqueued", index: i });
			}
		} catch {
			// Never propagate: a throw would flip a completed parent to retryable and double-spend. The
			// reason is a fixed enum, never the raw error message, so no host path can leak into a log line.
			log("chain-collect-error", { jobId: job?.id, reason: "chain-collect-error" });
		}

		return { enqueued, refused };
	};
}
