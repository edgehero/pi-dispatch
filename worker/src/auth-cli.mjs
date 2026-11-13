import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.mjs";
import { configuredSubscriptions } from "./subscription-config.mjs";
import { subscriptionIdentity } from "./subscription-runtime.mjs";
import { makeRedisClient, urlShown, VALKEY_COMMAND_TIMEOUT_MS } from "./connection.mjs";
import { valkeyDownHint } from "./valkey-auth.mjs";
import { boundedText } from "./cancel-cli.mjs";
import { openBrowser } from "./open-browser.mjs";
import { authError } from "./auth-store.mjs";
import { OPENAI_LOGIN_INSTRUCTIONS } from "./oauth-openai.mjs";

/** Native pi selects use `id`; older community callbacks use `value`. Only an offered choice can leave the prompt. */
export function authSelectAnswer(question, answer) {
	const options = Array.isArray(question?.options) ? question.options : [];
	const values = options.map((option) => option?.value ?? option?.id);
	if (!values.length || values.some((value) => typeof value !== "string" || !value)) throw authError("auth-selection-invalid");
	const input = typeof answer === "string" ? answer.trim() : "";
	if (/^\d+$/.test(input)) {
		const index = Number(input) - 1;
		if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) throw authError("auth-selection-invalid");
		return values[index];
	}
	if (!values.includes(input)) throw authError("auth-selection-invalid");
	return input;
}

/**
 * The line for a Valkey failure (issue #867), or null when `error` is no Valkey failure: Valkey's own refusal (a reply),
 * a configuration refusal this project raised (`valkeyRefused`), or a command that got no answer (a bound that fired, or
 * one that reached a Valkey and lost its answer). `seen` is the client's last `error` event, which says why a client
 * that never connected got none ("nothing answers VALKEY_URL ...") where the timeout says only that it got none. After a
 * login or a logout the failure is the status read's, since neither sends anything to Valkey. `casLost` says the
 * trial's compare-and-set itself was sent and its answer lost, so the grant may have landed and is not said to have
 * failed; a read lost before it means the compare-and-set was never sent, and nothing is said of a grant.
 */
export function authValkeyLine(error, { command, url, seen = null, casLost = false }) {
	if (error?.valkeyRefused === true) return `Subscription authentication: ${boundedText(error.message)}`;
	const refused = error?.name === "ReplyError";
	// ioredis' own timeout by its words, not by `ETIMEDOUT` alone, which a provider's request can carry too.
	if (!refused && error?.message !== "Command timed out" && error?.valkeyMayStillRun !== true) return null;
	const lead = `Subscription authentication: ${command === "login" || command === "logout" ? `the ${command} finished, but ` : ""}Valkey at ${urlShown(url)}`;
	if (refused) return `${lead} refused ${boundedText(typeof error?.command?.name === "string" ? error.command.name.toUpperCase() : "a command")} (${boundedText(error.message)}).`;
	const trial = command === "trial" && casLost === true ? " The trial grant may or may not have been made." : "";
	return `${lead} did not answer (${boundedText(seen ?? error?.message)}).${trial} Run \`pi-dispatch auth status\` once it answers: ${valkeyDownHint(url)}`;
}

export async function runAuth(args, { env = process.env, write = (value) => process.stdout.write(value), writeErr = (value) => process.stderr.write(value), configure = configuredSubscriptions, configFn = loadConfig, redisFn = makeRedisClient, interaction = null, now = Date.now, terminalInput = process.stdin, terminalOutput = process.stdout, createPrompt = createInterface, openBrowserFn = openBrowser } = {}) {
	const [command = "status", id, ...rest] = args;
	if (!["status", "login", "logout", "usage", "trial"].includes(command) || rest.length > 0 || (command === "status" ? id !== undefined : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id ?? ""))) {
		writeErr("usage: pi-dispatch auth status | login CONNECTION | logout CONNECTION | usage CONNECTION | trial CONNECTION\n");
		return 2;
	}
	let redis;
	let prompt;
	let config;
	// The client's last error event since it was last ready, for the line a Valkey failure ends with: cleared when it goes
	// ready, so a line after a long login does not quote an outage that ended during it.
	let seen = null;
	let valkeyFailed = false;
	// Whether the one write `auth` sends, a quota compare-and-set (EVAL), was sent and lost its answer, so the line says a
	// trial grant may or may not have been made only then, never of a read lost before the write was sent.
	let casLost = false;
	try {
		config = configFn(env);
		if (!config.authConnectionsFile) { writeErr("Set PI_AUTH_CONNECTIONS_FILE to an operator-reviewed subscription connection policy.\n"); return 2; }
		// BOUNDED (issue #867): every command this client sends is a short read or one compare-and-set of a quota row, so one
		// that waits past VALKEY_COMMAND_TIMEOUT_MS is a Valkey that is gone or stopped answering. Without the bound `auth
		// status` and `auth usage` waited for as long as it stayed so (measured: `auth usage` on a closed port printed 18 stack
		// traces in 8 s, one per reconnect attempt, while its read sat in ioredis' offline queue for as long as Valkey stayed
		// gone). The bound is on each command, never on the client's life, so a login
		// that waits minutes on a browser is not cut short: the login itself sends nothing to Valkey, only the status read
		// after it. `disconnectTimeoutMs: 0`, as `cancel`'s probe, so the socket of a Valkey that stopped answering does not
		// hold the process past its last line.
		redis = redisFn(config.valkeyUrl, { commandTimeoutMs: VALKEY_COMMAND_TIMEOUT_MS, disconnectTimeoutMs: 0 });
		// Without a listener ioredis prints a stack trace per reconnect attempt, for as long as an outage outlasts this call.
		redis?.on?.("error", (err) => {
			seen = err?.message ?? String(err);
		});
		redis?.on?.("ready", () => {
			seen = null;
		});
		if (typeof redis?.eval === "function") {
			const evaluate = redis.eval.bind(redis);
			redis.eval = (...args) => Promise.resolve(evaluate(...args)).catch((err) => {
				if (err?.valkeyMayStillRun === true) casLost = true;
				throw err;
			});
		}
		const service = configure({ config, redis, now });
		if (!interaction) interaction = {
			async notify(event) {
				if (event?.type === "auth_url" && typeof event.url === "string" && event.url.startsWith("https://")) {
					write(`Open the authorization page on this host: ${event.url}\n`);
					if (URL.canParse(event.url) && new URL(event.url).origin === "https://auth.openai.com") write(`${OPENAI_LOGIN_INSTRUCTIONS}\n`);
					openBrowserFn(event.url);
				}
				if (event?.type === "device_code") write(`Authorization code: ${event.code ?? event.userCode ?? "shown in browser"}\n`);
			},
			async prompt(question) {
				if (!terminalInput.isTTY) throw Object.assign(new Error("interactive terminal required"), { code: "auth-terminal-required" });
				prompt ??= createPrompt({ input: terminalInput, output: terminalOutput });
				if (question.type === "select" && Array.isArray(question.options)) write(`${question.options.map((option, i) => `${i + 1}. ${option.label ?? option.value ?? option.id}`).join("\n")}\n`);
				const answer = await prompt.question(`${question.message ?? "Authorization response"}: `, question.signal ? { signal: question.signal } : {});
				if (question.type === "select") return authSelectAnswer(question, answer);
				return answer;
			},
		};
		let result;
		if (command === "login") result = await service.auth.login(id, { interaction, signal: AbortSignal.timeout(10 * 60_000) });
		else if (command === "logout") result = await service.auth.logout(id);
		else if (command === "usage") result = await service.runtime.usage(id);
		else if (command === "trial") {
			const row = (await service.auth.status()).find((entry) => entry.id === id && entry.active && entry.ownerHost === config.workerName);
			if (!row) throw Object.assign(new Error("connection inactive"), { code: "auth-connection-inactive" });
			const identity = subscriptionIdentity(row);
			const current = await service.quota.read(identity);
			result = await service.quota.grantOneTrial(identity, { expectedVersion: current.version, actorKind: "person" });
		} else result = await service.runtime.status();
		// A login may return private credentials from an adapter. Print only the host service's safe status after it.
		if (command === "login") result = await service.runtime.status();
		if (command === "logout") {
			const logout = { id, state: "disconnected", remoteRevocationConfirmed: result?.remoteRevocationConfirmed === true };
			let status;
			try { status = await service.runtime.status(); }
			catch (error) {
				status = { state: "unavailable", partial: true, connections: [] };
				// The logout is done (it sends nothing to Valkey) and its evidence printed below; a Valkey failure of the status
				// read is still said as the one line, and the client is dropped rather than asked to QUIT (issue #867).
				const line = authValkeyLine(error, { command, url: config.valkeyUrl, seen });
				if (line !== null) {
					valkeyFailed = true;
					writeErr(`${line}\n`);
				}
			}
			result = { ...status, logout };
		}
		write(`${JSON.stringify(result, (key, value) => ["accountGroup", "generation", "accountDigest", "credential", "registration"].includes(key) ? undefined : value, 2)}\n`);
		return result?.ok === false || result?.kind === "unavailable" ? 2 : 0;
	} catch (error) {
		// A Valkey failure is one plain line naming Valkey, exit 1 as the transient failure it is: "auth-unavailable" and
		// "Run auth status" said nothing of Valkey, and `auth status` needs the same Valkey.
		const line = config?.valkeyUrl ? authValkeyLine(error, { command, url: config.valkeyUrl, seen, casLost }) : null;
		if (line !== null) {
			valkeyFailed = true;
			writeErr(`${line}\n`);
			return 1;
		}
		const code = typeof error?.code === "string" && /^(?:auth|subscription)-[a-z-]+$/.test(error.code) ? error.code : "auth-unavailable";
		writeErr(`Subscription authentication: ${code}. Run auth status on the connection owner host.\n`);
		return error?.transient === true ? 1 : 2;
	} finally {
		prompt?.close();
		// After a Valkey failure QUIT would wait out one more bound on a Valkey that stopped answering, for nothing.
		if (valkeyFailed) redis?.disconnect?.();
		else try { await redis?.quit(); } catch { redis?.disconnect?.(); }
	}
}
