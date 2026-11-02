/**
 * The inputs the run-record fixtures are built from (issue #761, INT-RUN-HISTORY-FILE-CONTRACT): five runs with fixed
 * instants, handed to the `buildRecord` of every release by `.github/scripts/run-record-fixtures.mjs`, and to today's by
 * `worker/test/run-record-fixtures.test.mjs`. Plain data and no import, so a builder of any release reads the same
 * objects, and nothing here can drift with today's modules.
 *
 * The fixtures are the SHAPES each release's builder makes from these inputs, not everything that release wrote: a
 * builder handed a field its release never knew ignores it, and one handed a value its release never produced (a
 * reason token added later) writes it anyway.
 *
 * Every argument `buildRecord` has taken goes in the one object it has always taken (`host` from v1.7.0,
 * `defaultBackend` from v2.0.0, `project` from v3.0.0, `size` from v4.0.0, `capacity` and `earlier` from v4.1.0, then
 * `maxTurns` and `touchTracking`), and a builder ignores the keys it does not name.
 *
 * `maximal` carries every source field any release's builder reads, each in a form today's builder keeps, so its record
 * holds every key a record can hold at once. Its values need not describe one coherent run.
 */

/** The case names, in the order the fixtures and the manifest list them. */
export const RUN_RECORD_CASES = Object.freeze(["forge-completed", "local-cron-completed", "policy-refused", "failed-infra", "maximal"]);

const ms = (iso) => Date.parse(iso);
const hex = (n, c) => c.repeat(n);

/** A fresh input object for case `name`, so no builder can see what another one did to it. */
export function caseInput(name) {
	switch (name) {
		case "forge-completed":
			return {
				job: {
					id: "gh-6f1c2a9e-0b7d-4c1e-9a55-0d3b2f8e7a10",
					name: "github",
					attemptsMade: 0,
					stalledCounter: 0,
					timestamp: ms("2026-09-14T09:59:58.000Z"),
					opts: { delay: 0 },
					delay: 0,
					data: { kind: "github", repo: "acme/web", target: { type: "issue", number: 42 }, flow: "fix", trigger: { kind: "issues", matched: { index: 0, type: "label" } } },
				},
				result: {
					outcome: "completed",
					reason: null,
					exitCode: 0,
					turns: 12,
					tokens: { input: 48000, output: 6200, total: 54200, cost: 0.4125 },
					usage: { v: 1, piAi: "0.80.7", truncated: 0, models: [{ provider: "anthropic", model: "claude-sonnet-4-5", calls: 12, input: 48000, output: 6200, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 54200, cost: 0.4125, unpriced: 0 }] },
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					budgetReserved: true,
					session: { resumed: false, reason: "absent", bytes: 0 },
					dollars: { reservedMicros: 2_000_000, settledMicros: 412_500, basis: "metered", modelBasis: "metered" },
					resources: { memPeak: 734_003_200, swapPeak: 0, oomKills: 0, memSomeUsec: 1200, memFullUsec: 0, cpuUsec: 182_000_000, throttledUsec: 0, throttled: 0, pidsPeak: 41 },
				},
				startedAt: "2026-09-14T10:00:00.000Z",
				endedAt: "2026-09-14T10:07:30.000Z",
				host: "mini-1",
				defaultBackend: "docker",
				project: "web",
				size: { memMiB: 2048, cpuCenti: 200, source: "project" },
				capacity: { slots: 3, memMiB: 8192, cpuCenti: 400, cpus: 8 },
				earlier: null,
			};
		case "local-cron-completed":
			return {
				job: {
					id: `repeat:nightly-docs:${ms("2026-09-14T03:00:00.000Z")}`,
					name: "local",
					attemptsMade: 0,
					stalledCounter: 0,
					timestamp: ms("2026-09-13T03:00:00.000Z"),
					opts: { delay: ms("2026-09-14T03:00:00.000Z") - ms("2026-09-13T03:00:00.000Z") },
					delay: ms("2026-09-14T03:00:00.000Z") - ms("2026-09-13T03:00:00.000Z"),
					data: { kind: "local", folder: "/home/operator/sites/blog", flow: "docs", task: "refresh the changelog", trigger: { id: "nightly-docs", pattern: "0 3 * * *" } },
				},
				result: {
					outcome: "completed",
					exitCode: 0,
					turns: 5,
					tokens: { input: 9000, output: 1100, total: 10100, cost: 0.061 },
					provider: "openai",
					model: "gpt-5.5",
					budgetReserved: true,
					dollars: { reservedMicros: 1_000_000, settledMicros: 61_000, basis: "metered", modelBasis: null },
					resources: { memPeak: 402_653_184, swapPeak: 0, oomKills: 0, memSomeUsec: 0, memFullUsec: 0, cpuUsec: 41_000_000, throttledUsec: 0, throttled: 0, pidsPeak: 17 },
				},
				startedAt: "2026-09-14T03:00:02.000Z",
				endedAt: "2026-09-14T03:04:12.000Z",
				host: "mini-1",
				defaultBackend: "docker",
				project: "docs",
				size: { memMiB: 1024, cpuCenti: 100, source: "default" },
				capacity: { slots: 3, memMiB: 8192, cpuCenti: 400, cpus: 8 },
				earlier: null,
			};
		case "policy-refused":
			return {
				job: {
					id: "gl-b2a5f0c4-7e19-4c8b-8f3e-5d6a7b8c9d01",
					name: "gitlab",
					attemptsMade: 0,
					stalledCounter: 0,
					timestamp: ms("2026-09-14T11:29:59.000Z"),
					opts: { delay: 0 },
					delay: 0,
					data: { kind: "gitlab", repo: "acme/infra", target: { type: "merge_request", number: 7 }, flow: "check", trigger: { kind: "merge_request", matched: { index: 2, type: "pull_request" } } },
				},
				result: { outcome: "policy", reason: "over-budget", exitCode: null, turns: null, tokens: null, provider: "anthropic", model: "claude-sonnet-4-5", budgetReserved: false, why: "daily" },
				startedAt: "2026-09-14T11:30:00.000Z",
				endedAt: "2026-09-14T11:30:00.000Z",
				host: "mini-2",
				defaultBackend: "podman",
				project: "api",
				size: { memMiB: 2048, cpuCenti: 200, source: "env" },
				capacity: null,
				earlier: null,
			};
		case "failed-infra":
			return {
				job: {
					id: "gh-3e7b1d2c-4a5f-4e6d-8b9c-0a1b2c3d4e5f",
					name: "github",
					attemptsMade: 1,
					stalledCounter: 0,
					timestamp: ms("2026-09-14T12:00:00.000Z"),
					opts: { delay: 0 },
					delay: 5000,
					data: { kind: "github", repo: "acme/api", target: { type: "pull_request", number: 311 }, flow: "check", trigger: { kind: "pull_request", matched: { index: 1, type: "pull_request" } } },
				},
				error: Object.assign(new Error("the job container exited 1 before its exit line"), { reason: "container-infra-exit", exitCode: 1, turns: 3, provider: "anthropic", model: "claude-sonnet-4-5", budgetReserved: true, dollars: { reservedMicros: 2_000_000, settledMicros: 150_000, basis: "floor", modelBasis: "floor" } }),
				startedAt: "2026-09-14T12:05:00.000Z",
				endedAt: "2026-09-14T12:09:45.000Z",
				host: "mini-2",
				defaultBackend: "podman",
				project: "api",
				size: { memMiB: 2048, cpuCenti: 200, source: "project" },
				capacity: { slots: 2, memMiB: 6144, cpuCenti: 300, cpus: 4 },
				earlier: [{ host: "mini-1", startedAt: "2026-09-14T12:00:01.000Z", endedAt: "2026-09-14T12:04:00.000Z", memMiB: 2048, cpuCenti: 200 }],
			};
		case "maximal":
			return {
				job: {
					id: "gh-9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d-r2",
					name: "github",
					attemptsMade: 0,
					stalledCounter: 0,
					timestamp: ms("2026-09-14T13:59:00.000Z"),
					opts: { delay: 30_000 },
					delay: 30_000,
					data: {
						kind: "github",
						repo: "acme/api",
						target: { type: "issue", number: 99 },
						flow: "fix",
						backend: "openshell",
						parentJobId: "gh-1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a",
						chainDepth: 1,
						replica: 2,
						replicas: 2,
						trigger: { kind: "issue_comment", matched: { index: 3, type: "comment" } },
						recoveryOf: "gh-9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
						fork: { id: hex(32, "a"), fromJob: "gh-5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", fromEntry: "0a1b2c3d", position: "at", sourceDigest: hex(64, "b"), rootKey: hex(32, "c") },
						steer: true,
						canary: { sourceJobId: "gh-5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", role: "fast", candidate: "anthropic/claude-haiku-4-5" },
						purpose: "answer-draft",
						answerDraft: { runId: "gh-5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", ruleId: "triage" },
						secretsProfile: "prod",
					},
				},
				result: {
					outcome: "completed",
					reason: "awaiting-approval",
					exitCode: 0,
					turns: 31,
					tokens: { input: 210_000, output: 18_000, total: 228_000, cost: 1.86, metered: 228_000, calls: 31 },
					usage: { v: 1, piAi: "0.80.7", truncated: 0, models: [{ provider: "anthropic", model: "claude-sonnet-4-5", calls: 28, input: 200_000, output: 17_000, cacheRead: 120_000, cacheWrite: 8000, cacheWrite1h: 0, reasoning: 2000, total: 217_000, cost: 1.8, unpriced: 0 }, { provider: "anthropic", model: "claude-haiku-4-5", calls: 3, input: 10_000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 11_000, cost: 0.06, unpriced: 0 }] },
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					modelRole: "fast",
					modelWhy: "fallback-cooldown",
					providerFailure: { kind: "rate-limited", resetAt: ms("2026-09-14T14:30:00.000Z") },
					modelRoles: { refusals: [{ agentHash: hex(64, "d"), reason: "unknown-role" }] },
					budgetReserved: true,
					chainRefused: 1,
					session: { resumed: true, reason: "resumed", bytes: 48_213 },
					dollars: { reservedMicros: 3_000_000, settledMicros: 1_860_000, basis: "metered", modelBasis: "metered" },
					decision: { model: "anthropic/claude-haiku-4-5", action: "investigate", shadow: false, questions: ["scope"], probabilities: { investigate: 0.7, file_issue: 0.2, ignore: 0.1 }, confidence: 0.7, costUsd: 0.002 },
					approval: { requestId: hex(64, "e"), action: "deploy:prod", decision: "approved", actorKind: "operator", actorId: hex(64, "f"), decidedAt: ms("2026-09-14T14:20:00.000Z") },
					why: "fallback",
					plan: { outcome: "applied", reason: null, planId: hex(16, "1"), clamped: true },
					resources: { memPeak: 1_610_612_736, swapPeak: 4096, oomKills: 0, memSomeUsec: 5400, memFullUsec: 120, cpuUsec: 960_000_000, throttledUsec: 12_000, throttled: 3, pidsPeak: 88 },
					hostBudget: { memMiB: 16_384, cpuCenti: "off", hostShare: 50 },
					progress: { turns: 31, steps: 44, failed: 2, interrupted: 1, replayed: 1, toolMs: 61_000, longestStepMs: 9000, longestInterruptedMs: 3000, phasesDeclared: 3, lastPhaseIndex: 2, tools: { read: 12, bash: 9, edit: 6, write: 2, grep: 5, find: 1, ls: 2, await_human_input: 1, report_progress: 3, other: 3 } },
					recovered: { from: "exit", n: 1, fromAttempt: 1, checkpointSeq: 4, orphans: 1, replayed: 1, interrupted: 0, notStarted: 0, countsFrom: "exit-line" },
					recoverSkipped: "base-unprimed",
					checkpoints: { written: 3, failed: 0, skipped: 1 },
					forkSource: { saved: false, reason: "fork-source-capacity", pointSkipped: "fork-timeout" },
					steered: { delivered: 2, late: 1, withdrawn: 0 },
					steerSkipped: "no-inbox",
					bundle: { id: "prod-env", variables: ["DB_URL", "API_KEY"], shadowed: [], placeholders: 1, plain: 1, placeholderNames: ["API_KEY"] },
					liveSkipped: "no-capability",
					openshell: { mode: "copy", ruleHosts: ["github.com", "api.anthropic.com"], ruleHostCount: 2, providers: 1, placeholders: 1 },
					touches: [{ runId: "gh-9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d-r2", at: ms("2026-09-14T14:10:00.000Z"), cause: "steer" }],
					touchLineageSkipped: "source-unavailable",
				},
				startedAt: "2026-09-14T14:00:00.000Z",
				endedAt: "2026-09-14T14:25:00.000Z",
				host: "mini-2",
				defaultBackend: "docker",
				project: "api",
				size: { memMiB: 4096, cpuCenti: 300, source: "project" },
				capacity: { slots: 2, memMiB: 6144, cpuCenti: 300, cpus: 4 },
				earlier: [{ host: "mini-1", startedAt: "2026-09-14T13:40:00.000Z", endedAt: "2026-09-14T13:52:00.000Z", memMiB: 4096, cpuCenti: 300 }],
				maxTurns: 40,
				touchTracking: true,
			};
		default:
			throw new RangeError(`no run-record case named ${JSON.stringify(name)}`);
	}
}
