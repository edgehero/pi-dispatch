import { parseArgs } from "node:util";
import { canaryOptions, canaryText, executeCanary } from "./canary.mjs";

export const CANARY_ENV_KEYS = Object.freeze(["PI_WORKER_NAME", "PI_LOGS_DIR", "PI_JOBS_DIR", "PI_SANDBOX_DIR", "PI_SANDBOX_RETENTION_HOURS", "PI_SETTINGS_FILE", "PI_TRIGGERS_FILE", "PI_BACKENDS", "PI_JOB_IMAGE", "PI_MAX_COST_USD", "PI_DAILY_COST_USD", "PI_WEEKLY_COST_USD", "PI_MONTHLY_COST_USD", "PI_DAILY_CAP", "PI_WEEKLY_CAP", "PI_MONTHLY_CAP", "PI_SOFT_HOLD_PCT", "PI_DAILY_TOKEN_CAP", "PI_MAX_TOKENS", "PI_MAX_TURNS", "PI_MODEL", "PI_PROVIDER", "PI_SCOPED_LIMITS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_ENVELOPE_FILE", "PI_HOST_MEMORY_BUDGET", "PI_HOST_CPU_BUDGET", "PI_HOST_RESERVE_MEMORY", "PI_HOST_RESERVE_CPUS", "PI_MODEL_ENDPOINTS_FILE", "PI_AUTH_FROM_PI", "PI_AUTH_CONNECTIONS_FILE"]);
const PRIVATE_ENV_KEYS = Object.freeze(["VALKEY_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]);

export async function runCanary(args, { env = process.env, write = (s) => process.stdout.write(s), errWrite = (s) => process.stderr.write(s), deploymentEnv = (e) => ({ env: e }), runtimeFactory, now = Date.now } = {}) {
	let runtime;
	try {
		const { values } = parseArgs({ args, allowPositionals: false, options: { role: { type: "string" }, model: { type: "string" }, flow: { type: "string" }, count: { type: "string", default: "3" }, "cap-usd": { type: "string" }, json: { type: "boolean", default: false } } });
		const options = canaryOptions({ ...values, capUsd: values["cap-usd"] });
		const deployment = deploymentEnv(env, CANARY_ENV_KEYS);
		if (deployment.problem) throw new Error(deployment.problem);
		const credentials = deploymentEnv(deployment.env, PRIVATE_ENV_KEYS);
		if (credentials.problem) throw new Error("canary provider credentials or Valkey configuration cannot be reconciled between this shell and .env; make those sources agree");
		const create = runtimeFactory ?? (await import("./canary-runtime.mjs")).createCanaryRuntime;
		runtime = await create({ env: credentials.env, options, now });
		const report = await executeCanary(options, { ...runtime, now });
		write(values.json ? `${JSON.stringify(report)}\n` : canaryText(report));
		return report.rows.every((r) => r.candidate.outcome === "completed") ? 0 : 2;
	} catch (error) {
		// Runtime errors are deliberately fixed messages: git, Docker and provider errors may carry text from a job.
		errWrite(`error: ${error.message}\n`);
		return 1;
	} finally {
		await runtime?.close?.();
	}
}
