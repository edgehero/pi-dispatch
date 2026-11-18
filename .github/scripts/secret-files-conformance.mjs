// The same byte and isolation probe runs through Podman and both OpenShell transports. Only hashes are baked into
// the image: a successful comparison proves the worker delivered the separately supplied values to this attempt.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SECRET_FILES_DIR_SUFFIX, SECRET_FILES_SUBDIR } from "../../worker/src/secret-files.mjs";

export const SECRET_FILE_FIXTURES = Object.freeze({
	CREDENTIAL_NO_EOL: "secret-file-conformance-no-eol-919",
	CREDENTIAL_LF: "secret-file-conformance-lf-a-919\nsecret-file-conformance-lf-b-919\n",
	CREDENTIAL_CRLF: "secret-file-conformance-crlf-a-919\r\nsecret-file-conformance-crlf-b-919\r\n",
	CREDENTIAL_UTF8: "secret-file-conformance-utf8-919: café 🎈\n",
});
const hashes = Object.fromEntries(Object.entries(SECRET_FILE_FIXTURES).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex")]));
const canaries = Object.values(SECRET_FILE_FIXTURES).flatMap((value) => [value, ...value.split(/\r?\n/).filter(Boolean)]);
const containsValue = (text) => canaries.some((value) => String(text ?? "").includes(value));

export const SECRET_FILES_PROBE_SOURCE = `import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { verifySecretFiles } from "/app/image/runner/src/secret-files.mjs";
const expected = ${JSON.stringify(hashes)};
const directory = process.env.PI_JOB_LAYOUT === "sandbox" ? "/sandbox/secrets" : "/run/secrets";
const facts = { verified: false, paths: false, bytes: false, owner: false, modes: false, readonly: false, cmdline: false, environ: false };
try {
	const names = Object.keys(expected);
	facts.paths = names.every((name) => process.env[name] === directory + "/" + name);
	facts.verified = verifySecretFiles({ directory }) === names.length;
	const parent = fs.statSync(directory);
	const values = names.map((name) => fs.readFileSync(process.env[name]));
	facts.bytes = names.every((name, i) => createHash("sha256").update(values[i]).digest("hex") === expected[name]);
	facts.owner = parent.uid === process.getuid() && names.every((name) => fs.statSync(process.env[name]).uid === process.getuid());
	facts.modes = (parent.mode & 0o777) === 0o700 && names.every((name) => (fs.statSync(process.env[name]).mode & 0o777) === 0o600);
	const denied = (write) => { try { write(); return false; } catch (error) { return ["EROFS", "EACCES", "EPERM"].includes(error.code); } };
	facts.readonly = names.every((name) => denied(() => fs.appendFileSync(process.env[name], "planted"))) && denied(() => fs.writeFileSync(directory + "/PLANTED", "planted"));
	const leaks = (kind) => fs.readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name)).some((pid) => {
		let data; try { data = fs.readFileSync("/proc/" + pid + "/" + kind); } catch { return false; }
		return values.some((value) => data.includes(value));
	});
	facts.cmdline = !leaks("cmdline");
	facts.environ = !leaks("environ");
	// Exercise the worker's actual output and persisted-log redactors, without printing a value in the verdict.
	for (const value of values) { process.stdout.write(value.subarray(0, 11)); process.stdout.write(value.subarray(11)); process.stdout.write("\\n"); }
} catch { facts.error = "probe-failed"; }
console.log("secret-files " + JSON.stringify(facts));
process.exit(Object.values(facts).every((value) => value === true) ? 0 : 1);
`;

/** A missing read is a failure. Never include the captured output, argv or log contents in a diagnostic. */
export function secretFileStageRemoved(jobDir, fs = { existsSync }) {
	return !fs.existsSync(`${jobDir}${SECRET_FILES_DIR_SUFFIX}`) && !fs.existsSync(join(`${jobDir}.openshell-up`, SECRET_FILES_SUBDIR));
}

export function judgeSecretFilesProbe({ code, output, jobDir, commands, gatewayLog, persistedLog, copy = false, fs = { existsSync } }) {
	let facts = {};
	try { facts = JSON.parse(/^secret-files (\{.*\})$/m.exec(String(output ?? ""))?.[1] ?? "{}"); } catch {}
	const measured = ["verified", "paths", "bytes", "owner", "modes", "readonly", "cmdline", "environ"];
	const checks = {
		probe: code === 0 && measured.every((key) => facts[key] === true),
		stageRemoved: !fs.existsSync(`${jobDir}${SECRET_FILES_DIR_SUFFIX}`),
		noUploadCopy: !fs.existsSync(join(`${jobDir}.openshell-up`, SECRET_FILES_SUBDIR)),
		commandsRead: Array.isArray(commands) && commands.length > 0,
		commandsClean: Array.isArray(commands) && !commands.some((args) => args.some(containsValue)),
		...(copy ? { uploadedDirectly: Array.isArray(commands) && commands.some((args) => args.includes("upload") && args.includes(join(`${jobDir}${SECRET_FILES_DIR_SUFFIX}`, SECRET_FILES_SUBDIR))) } : {}),
		outputClean: typeof output === "string" && !containsValue(output),
		persistedLogRead: typeof persistedLog === "string" && persistedLog.length > 0,
		persistedLogClean: typeof persistedLog === "string" && !containsValue(persistedLog),
		...(gatewayLog === undefined ? {} : { gatewayLogRead: typeof gatewayLog === "string" && gatewayLog.length > 0, gatewayLogClean: !containsValue(gatewayLog) }),
	};
	return { ok: Object.values(checks).every((value) => value === true), detail: JSON.stringify({ facts, ...checks }) };
}
