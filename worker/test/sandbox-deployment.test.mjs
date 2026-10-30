import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tempDir } from "./helpers/temp-dir.mjs";
import { sandboxDeploymentEnv } from "../src/sandbox-deployment.mjs";

function deployment(text = "PI_WORKER_NAME=mini1\nPI_BACKENDS=podman\nPI_SANDBOX_DIR=/var/lib/pi/sandboxes\nPI_EGRESS=1\nVALKEY_PASSWORD=private_value_not_forwarded_to_container\nPROVIDER_API_KEY=excluded\n") {
	const dir = fs.realpathSync(tempDir("sandbox-deployment-"));
	fs.chmodSync(dir, 0o700);
	fs.writeFileSync(join(dir, ".env"), text, { mode: 0o600 });
	return dir;
}

test("explicit deployment handoff reads trusted settings and constructs an allowlisted environment", () => {
	const dir = deployment();
	const result = sandboxDeploymentEnv({ dir, env: { HOME: homedir(), TERM: "xterm", PATH: "/usr/bin:/bin", UNRELATED_SECRET: "never", NODE_OPTIONS: "--require /evil" }, expectedHost: "mini1" });
	assert.equal(result.refused, undefined, result.message);
	assert.equal(result.env.PI_BACKENDS, "podman");
	assert.equal(result.env.PI_SANDBOX_DIR, "/var/lib/pi/sandboxes");
	assert.equal(result.env.PI_EGRESS, "1");
	assert.equal(result.env.TERM, "xterm");
	assert.equal(result.env.PROVIDER_API_KEY, undefined);
	assert.equal(result.env.UNRELATED_SECRET, undefined);
	assert.equal(result.env.NODE_OPTIONS, undefined);
	assert.equal(result.env.VALKEY_PASSWORD, "private_value_not_forwarded_to_container", "host session monitor alone needs its Valkey credential");
});

test("ambient egress bypass absent from the deployment refuses rather than overriding deployment defaults", () => {
	const dir = deployment("PI_WORKER_NAME=mini1\nPI_BACKENDS=local\n");
	for (const [key, value] of [["PI_EGRESS", "0"], ["DOCKER_HOST", "tcp://evil:2375"], ["PI_BACKEND_FLOOR", "network:private"], ["XDG_DATA_HOME", "/another/store"]]) {
		const result = sandboxDeploymentEnv({ dir, env: { [key]: value }, expectedHost: "mini1" });
		assert.equal(result.refused, "sandbox-deployment");
		assert.match(result.message, new RegExp(key));
		assert.ok(!result.message.includes(value), "refusal names the key, never the value");
	}
	assert.equal(sandboxDeploymentEnv({ dir, env: {}, expectedHost: "mini1" }).env.PI_EGRESS, undefined, "the normal armed default applies");
});

test("disagreeing settings, unsafe files, wrong worker identity and wrong home refuse", () => {
	const dir = deployment();
	assert.match(sandboxDeploymentEnv({ dir, env: { PI_EGRESS: "0" } }).message, /disagrees/);
	assert.match(sandboxDeploymentEnv({ dir, env: {}, expectedHost: "other" }).message, /worker name/);
	assert.match(sandboxDeploymentEnv({ dir, env: { HOME: "/wrong" }, home: homedir() }).message, /HOME/);
	fs.chmodSync(join(dir, ".env"), 0o666);
	assert.match(sandboxDeploymentEnv({ dir, env: {} }).message, /trusted/);
});

test("the deployment reader never sources shell expressions or accepts a missing deployment", () => {
	const dir = deployment("PI_WORKER_NAME=mini1\nPI_EGRESS=$(touch never)\n");
	assert.match(sandboxDeploymentEnv({ dir, env: {} }).message, /trusted|read/);
	fs.rmSync(join(dir, ".env"));
	assert.match(sandboxDeploymentEnv({ dir, env: {} }).message, /missing/);
	assert.match(sandboxDeploymentEnv({ dir: ".", env: {} }).message, /absolute/);
});

test("trusted TLS endpoints, shared Valkey and rootless configuration inputs survive the clean handoff", () => {
	const authority = { DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/private/docker-certs", PI_VALKEY_SHARED: "1", XDG_CONFIG_HOME: "/private/worker-config", CONTAINER_HOST: "unix:///run/user/1001/podman/podman.sock", CONTAINER_CONNECTION: "worker", CONTAINERS_REGISTRIES_CONF: "/private/worker-registries.conf" };
	const dir = deployment("PI_WORKER_NAME=mini1\n" + Object.entries(authority).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
	const result = sandboxDeploymentEnv({ dir, env: authority, expectedHost: "mini1" });
	assert.equal(result.refused, undefined, result.message);
	for (const [key, value] of Object.entries(authority)) assert.equal(result.env[key], value, key);
	const absent = deployment("PI_WORKER_NAME=mini1\n");
	for (const key of Object.keys(authority)) assert.match(sandboxDeploymentEnv({ dir: absent, env: { [key]: authority[key] } }).message, new RegExp(key), "ambient authority never substitutes for a deployment assignment");
});

test("a trusted runtime PATH replaces SSH's incomplete fallback while relative tool directories refuse", () => {
	const dir = deployment("PI_WORKER_NAME=mini1\nPATH=/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin\n");
	const result = sandboxDeploymentEnv({ dir, env: { PATH: "/usr/bin:/bin" }, expectedHost: "mini1" });
	assert.equal(result.refused, undefined, result.message);
	assert.equal(result.env.PATH, "/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin");
	const absent = deployment("PI_WORKER_NAME=mini1\n");
	assert.equal(sandboxDeploymentEnv({ dir: absent, env: { PATH: "/usr/bin:/bin" } }).env.PATH, "/usr/bin:/bin");
	for (const path of [".:/usr/bin", "/usr/bin:", "", "relative/bin"]) {
		const bad = deployment(`PI_WORKER_NAME=mini1\nPATH=${path}\n`);
		assert.ok(sandboxDeploymentEnv({ dir: bad, env: {} }).refused, path);
	}
});

test("PATH controls refuse as values while file newlines follow the service's actual loader", () => {
	const absent = deployment("PI_WORKER_NAME=mini1\n");
	for (const platform of ["linux", "darwin"]) {
		for (const path of ["/usr/bin\n/bin", "/usr/bin\r/bin", "/usr/bin\x00/bin"]) {
			assert.ok(sandboxDeploymentEnv({ dir: absent, env: { PATH: path }, platform }).refused, `${platform}: an actual PATH value cannot contain a control`);
		}
	}
	const split = deployment("PI_WORKER_NAME=mini1\nPATH=/usr/bin\n/bin\n");
	// systemd ignores the non-assignment line; a sourcing shell would execute it. It is not a newline in PATH.
	const linux = sandboxDeploymentEnv({ dir: split, env: {}, platform: "linux" });
	assert.equal(linux.refused, undefined, linux.message);
	assert.equal(linux.env.PATH, "/usr/bin");
	assert.ok(sandboxDeploymentEnv({ dir: split, env: {}, platform: "darwin" }).refused);
});
