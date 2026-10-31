import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.mjs";
import { configuredSubscriptions } from "./subscription-config.mjs";
import { subscriptionIdentity } from "./subscription-runtime.mjs";
import { makeRedisClient } from "./connection.mjs";
import { openBrowser } from "./open-browser.mjs";
import { authError } from "./auth-store.mjs";

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

export async function runAuth(args, { env = process.env, write = (value) => process.stdout.write(value), writeErr = (value) => process.stderr.write(value), configure = configuredSubscriptions, configFn = loadConfig, redisFn = makeRedisClient, interaction = null, now = Date.now, terminalInput = process.stdin, terminalOutput = process.stdout, createPrompt = createInterface, openBrowserFn = openBrowser } = {}) {
	const [command = "status", id, ...rest] = args;
	if (!["status", "login", "logout", "usage", "trial"].includes(command) || rest.length > 0 || (command === "status" ? id !== undefined : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id ?? ""))) {
		writeErr("usage: pi-dispatch auth status | login CONNECTION | logout CONNECTION | usage CONNECTION | trial CONNECTION\n");
		return 2;
	}
	let redis;
	let prompt;
	try {
		const config = configFn(env);
		if (!config.authConnectionsFile) { writeErr("Set PI_AUTH_CONNECTIONS_FILE to an operator-reviewed subscription connection policy.\n"); return 2; }
		redis = redisFn(config.valkeyUrl);
		const service = configure({ config, redis, now });
		if (!interaction) interaction = {
			async notify(event) {
				if (event?.type === "auth_url" && typeof event.url === "string" && event.url.startsWith("https://")) {
					write(`Open the authorization page on this host: ${event.url}\n`);
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
			catch { status = { state: "unavailable", partial: true, connections: [] }; }
			result = { ...status, logout };
		}
		write(`${JSON.stringify(result, (key, value) => ["accountGroup", "generation", "accountDigest", "credential", "registration"].includes(key) ? undefined : value, 2)}\n`);
		return result?.ok === false || result?.kind === "unavailable" ? 2 : 0;
	} catch (error) {
		const code = typeof error?.code === "string" && /^(?:auth|subscription)-[a-z-]+$/.test(error.code) ? error.code : "auth-unavailable";
		writeErr(`Subscription authentication: ${code}. Run auth status on the connection owner host.\n`);
		return error?.transient === true ? 1 : 2;
	} finally {
		prompt?.close();
		try { await redis?.quit(); } catch { redis?.disconnect?.(); }
	}
}
