/**
 * The environment a container started from a job argv gets, rebuilt by the runtime client's own rule (issue #1114).
 *
 * Since issue #1114 a credential is a bare `-e NAME` on the argv, its value in the client's spawn environment, so a test
 * that splits `-e` tokens on `=` reads a bare name as `undefined`: "absent" assertions would then pass whatever the code
 * does. Every job-env read in the suite goes through here instead, from the argv AND the spawn's options the fake spawn
 * captured, so a bare name that is present and one that is absent read differently.
 *
 * Every token but the last is read, the last being the image a job argv ends with (`assertJobEnvArgv` reads the same
 * tokens). A spawn whose options carry no `env` reads as one that holds none: docker would borrow the runner's own
 * environment there, and a regression that drops the spawn env must not pass by borrowing the test process's.
 */
export function containerEnvOf(args, opts = {}) {
	const source = opts?.env ?? {};
	const env = {};
	for (const token of envTokensOf(args)) {
		const eq = token.indexOf("=");
		if (eq >= 0) env[token.slice(0, eq)] = token.slice(eq + 1);
		else if (Object.hasOwn(source, token)) env[token] = source[token];
	}
	return env;
}

/** Every variable an argv names with `-e` in every token but the last (its image), bare or with a value, in order: what "not on the argv" reads. */
export function envNamesOf(args) {
	return envTokensOf(args).map((token) => (token.includes("=") ? token.slice(0, token.indexOf("=")) : token));
}

function envTokensOf(args) {
	const head = args.slice(0, -1);
	const tokens = [];
	for (let i = 0; i < head.length - 1; i++) if (head[i] === "-e") tokens.push(head[++i]);
	return tokens;
}
