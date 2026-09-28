import { test } from "node:test";
import assert from "node:assert/strict";
import { EGRESS_PROXY_CMD, EGRESS_PROXY_ENTRYPOINT, EGRESS_PROXY_IMAGE, jobNetworksOf, parseProxyState, shippedProxyDrift } from "../src/egress-proxy-state.mjs";

// Issue #453, gate round 2: `PROXY_STATE_FORMAT`'s answer for the shipped proxy on a real Docker Engine (29.8.1,
// compose 5.5.1, Ubuntu, rootful), copied byte for byte from round-446/pr3/m453/raw-m453-docker-engine.txt. C1 was made
// by `docker compose -f deploy/docker-compose.yml --profile egress up -d` from the real folder /var/tmp/m453/dep; U2 by
// `up`'s own `docker run` argv from /var/tmp/m453/link, a symlink to it, whose path docker kept as given.
const MEASURED_COMPOSE = String.raw`{"status":"running","health":"starting","image":"ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029","entrypoint":["entrypoint.sh"],"cmd":["-f","/etc/squid/squid.conf","-NYC"],"mounts":[{"Type":"bind","Source":"/var/tmp/m453/dep/egress-allowlist.conf","Destination":"/etc/pi-dispatch/allowlist.conf","Mode":"ro,z","RW":false,"Propagation":"rprivate"},{"Type":"bind","Source":"/var/tmp/m453/dep/deploy/egress-proxy.conf","Destination":"/etc/squid/squid.conf","Mode":"ro,z","RW":false,"Propagation":"rprivate"},{"Type":"volume","Name":"eec1ec575581eb2532f1b5e0b9ab4aa6d6c82c3c0ce70319a7eaab9d130911b1","Source":"/var/lib/docker/volumes/eec1ec575581eb2532f1b5e0b9ab4aa6d6c82c3c0ce70319a7eaab9d130911b1/_data","Destination":"/var/log/squid","Driver":"local","Mode":"","RW":true,"Propagation":""},{"Type":"volume","Name":"d6c30b792e8cff6bf529e072f53986fa3da1478104257f4b8f26b54ed3356faf","Source":"/var/lib/docker/volumes/d6c30b792e8cff6bf529e072f53986fa3da1478104257f4b8f26b54ed3356faf/_data","Destination":"/var/spool/squid","Driver":"local","Mode":"","RW":true,"Propagation":""}],"networks":{"pi-dispatch-egress-out":{"IPAMConfig":null,"Links":null,"Aliases":["pi-dispatch-egress-proxy","egress-proxy"],"DriverOpts":null,"GwPriority":0,"NetworkID":"91ee40174e9c170ffa2b46a8c0b7dc08f92be3ff65f944da2df39d9b74356a25","EndpointID":"a635380754dfc55d65df63919622965ddc8a08c85078d3c05818a7936bf52421","Gateway":"172.18.0.1","IPAddress":"172.18.0.2","MacAddress":"fa:27:f9:dc:f3:17","IPPrefixLen":16,"IPv6Gateway":"","GlobalIPv6Address":"","GlobalIPv6PrefixLen":0,"DNSNames":["pi-dispatch-egress-proxy","egress-proxy","613986d80a53"]}}}`;
const MEASURED_UP_VIA_SYMLINK = String.raw`{"status":"running","health":"none","image":"ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029","entrypoint":["entrypoint.sh"],"cmd":["-f","/etc/squid/squid.conf","-NYC"],"mounts":[{"Type":"bind","Source":"/var/tmp/m453/link/egress-allowlist.conf","Destination":"/etc/pi-dispatch/allowlist.conf","Mode":"ro,z","RW":false,"Propagation":"rprivate"},{"Type":"bind","Source":"/var/tmp/m453/link/deploy/egress-proxy.conf","Destination":"/etc/squid/squid.conf","Mode":"ro,z","RW":false,"Propagation":"rprivate"},{"Type":"volume","Name":"000ea052364aab9a221eef6585c91a7b9e0449433c84ec3e1cc670fec0072ff9","Source":"/var/lib/docker/volumes/000ea052364aab9a221eef6585c91a7b9e0449433c84ec3e1cc670fec0072ff9/_data","Destination":"/var/log/squid","Driver":"local","Mode":"","RW":true,"Propagation":""},{"Type":"volume","Name":"da79a826deb0e79a01605e4b5d84af808770dfef684bcde0600a613b71c09cb7","Source":"/var/lib/docker/volumes/da79a826deb0e79a01605e4b5d84af808770dfef684bcde0600a613b71c09cb7/_data","Destination":"/var/spool/squid","Driver":"local","Mode":"","RW":true,"Propagation":""}],"networks":{"pi-dispatch-egress-out":{"IPAMConfig":null,"Links":null,"Aliases":null,"DriverOpts":null,"GwPriority":0,"NetworkID":"45c8be00149c32493ead92dd2d77b3d0964a12494765dee48c4387be61968468","EndpointID":"41e07ebd39e69be2a56a86ce74f2f787749c70e3197838a1c95a97cc9528e0d5","Gateway":"172.18.0.1","IPAddress":"172.18.0.2","MacAddress":"3a:ca:04:d5:d7:b2","IPPrefixLen":16,"IPv6Gateway":"","GlobalIPv6Address":"","GlobalIPv6PrefixLen":0,"DNSNames":["pi-dispatch-egress-proxy","0e66893f026a"]}}}`;
// The VM's symlink, resolved as that host resolved it.
const realpath = (p) => p.replace(/^\/var\/tmp\/m453\/link(?=\/|$)/, "/var/tmp/m453/dep");

test("the measured Docker Engine shapes parse, and a compose-made or up-made proxy from the real or the symlinked folder is current (#453 gate 2)", () => {
	for (const [label, raw] of [["compose", MEASURED_COMPOSE], ["up via the symlink", MEASURED_UP_VIA_SYMLINK]]) {
		const state = parseProxyState(raw);
		assert.equal(state.status, "running", label);
		assert.equal(state.image, EGRESS_PROXY_IMAGE, `${label}: docker keeps the reference as written`);
		assert.deepEqual(state.entrypoint, [...EGRESS_PROXY_ENTRYPOINT], `${label}: neither compose nor up sets one, so the image's`);
		assert.deepEqual(state.cmd, [...EGRESS_PROXY_CMD], label);
		assert.deepEqual(state.mounts.map((m) => [m.type, m.destination]).sort(), [["bind", "/etc/pi-dispatch/allowlist.conf"], ["bind", "/etc/squid/squid.conf"], ["volume", "/var/log/squid"], ["volume", "/var/spool/squid"]], label);
		assert.deepEqual(state.networks, ["pi-dispatch-egress-out"], label);
		assert.deepEqual(jobNetworksOf(state), [], label);
		for (const cwd of ["/var/tmp/m453/dep", "/var/tmp/m453/link"]) assert.deepEqual(shippedProxyDrift(state, { cwd, realpath }), { drift: [], unknown: null }, `${label} judged from ${cwd}`);
	}
	// Compose's healthcheck is in the answer; up's run carries none.
	assert.equal(parseProxyState(MEASURED_COMPOSE).health, "starting");
	assert.equal(parseProxyState(MEASURED_UP_VIA_SYMLINK).health, "none");
});

// Gate round 3, read only on pd-fedora (round-446/pr3/r3/raw-r3-compat-inspect.txt): root's rootful Podman 5.8.1 and its
// compose-made proxy (whose folder had since been deleted), through its Docker API (the `local` venue's route, docker
// CLI 29.7.2) and natively, with `PROXY_STATE_FORMAT`. Both render the argv as lists and the health as "".
const MEASURED_PODMAN_COMPAT = String.raw`{"status":"exited","health":"","image":"docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029","entrypoint":["entrypoint.sh"],"cmd":["-f","/etc/squid/squid.conf","-NYC"],"mounts":[{"Type":"volume","Name":"9c75e38082d0239e57e22b039ac7c9d62e983594c530e671f476274b328f270d","Source":"/var/lib/containers/storage/volumes/9c75e38082d0239e57e22b039ac7c9d62e983594c530e671f476274b328f270d/_data","Destination":"/var/log/squid","Driver":"local","Mode":"","RW":true,"Propagation":"rprivate"},{"Type":"volume","Name":"40c34d3773e8ad982609adaaf9db1d5b803e785ec13aeffaa7b74da22768372c","Source":"/var/lib/containers/storage/volumes/40c34d3773e8ad982609adaaf9db1d5b803e785ec13aeffaa7b74da22768372c/_data","Destination":"/var/spool/squid","Driver":"local","Mode":"","RW":true,"Propagation":"rprivate"},{"Type":"bind","Source":"/home/op/pi-dispatch/egress-allowlist.conf","Destination":"/etc/pi-dispatch/allowlist.conf","Mode":"","RW":false,"Propagation":"rprivate"},{"Type":"bind","Source":"/home/op/pi-dispatch/deploy/egress-proxy.conf","Destination":"/etc/squid/squid.conf","Mode":"","RW":false,"Propagation":"rprivate"}],"networks":{"pi-dispatch-egress-out":{"IPAMConfig":null,"Links":null,"Aliases":["pi-dispatch-egress-proxy","egress-proxy","3255b77c3ee3"],"DriverOpts":null,"GwPriority":0,"NetworkID":"65d36765319ca45a39cc062b1daf1fa193a8d263ad380f4a29195e6687ddab18","EndpointID":"","Gateway":"","IPAddress":"","MacAddress":"","IPPrefixLen":0,"IPv6Gateway":"","GlobalIPv6Address":"","GlobalIPv6PrefixLen":0,"DNSNames":null}}}`;
const MEASURED_PODMAN_NATIVE = String.raw`{"status":"exited","health":"","image":"docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029","entrypoint":["entrypoint.sh"],"cmd":["-f","/etc/squid/squid.conf","-NYC"],"mounts":[{"Type":"volume","Name":"9c75e38082d0239e57e22b039ac7c9d62e983594c530e671f476274b328f270d","Source":"/var/lib/containers/storage/volumes/9c75e38082d0239e57e22b039ac7c9d62e983594c530e671f476274b328f270d/_data","Destination":"/var/log/squid","Driver":"local","Mode":"","Options":["nodev","exec","nosuid","rbind"],"RW":true,"Propagation":"rprivate"},{"Type":"volume","Name":"40c34d3773e8ad982609adaaf9db1d5b803e785ec13aeffaa7b74da22768372c","Source":"/var/lib/containers/storage/volumes/40c34d3773e8ad982609adaaf9db1d5b803e785ec13aeffaa7b74da22768372c/_data","Destination":"/var/spool/squid","Driver":"local","Mode":"","Options":["nodev","exec","nosuid","rbind"],"RW":true,"Propagation":"rprivate"},{"Type":"bind","Source":"/home/op/pi-dispatch/egress-allowlist.conf","Destination":"/etc/pi-dispatch/allowlist.conf","Driver":"","Mode":"","Options":["rbind"],"RW":false,"Propagation":"rprivate"},{"Type":"bind","Source":"/home/op/pi-dispatch/deploy/egress-proxy.conf","Destination":"/etc/squid/squid.conf","Driver":"","Mode":"","Options":["rbind"],"RW":false,"Propagation":"rprivate"}],"networks":{"pi-dispatch-egress-out":{"EndpointID":"","Gateway":"","IPAddress":"","IPPrefixLen":0,"IPv6Gateway":"","GlobalIPv6Address":"","GlobalIPv6PrefixLen":0,"MacAddress":"","NetworkID":"65d36765319ca45a39cc062b1daf1fa193a8d263ad380f4a29195e6687ddab18","DriverOpts":null,"IPAMConfig":null,"Links":null,"Aliases":["pi-dispatch-egress-proxy","egress-proxy","3255b77c3ee3"]}}}`;
// Gate round 3, adversary (gate456-adv/r3/raw-r3-podman49.txt): Podman 4.9.3's NATIVE inspect renders
// `.Config.Entrypoint` as a string, "entrypoint.sh" for the squid image's and "" for none.
const PODMAN_49_ENTRYPOINT = '{"entrypoint":"entrypoint.sh","cmd":["-f","/etc/squid/squid.conf","-NYC"]}';
const PODMAN_49_NO_ENTRYPOINT = '{"entrypoint":"","cmd":["/bin/sh"]}';

test("the argv is normalised whatever the runtime's spelling: Podman 4.9's string, its empty string, docker's null (#453 gate 3)", () => {
	const shape = (over) => JSON.stringify({ ...JSON.parse(MEASURED_COMPOSE), ...JSON.parse(over) });
	const v49 = parseProxyState(shape(PODMAN_49_ENTRYPOINT));
	assert.deepEqual(v49.entrypoint, ["entrypoint.sh"]);
	assert.deepEqual(shippedProxyDrift(v49, { cwd: "/var/tmp/m453/dep", realpath }), { drift: [], unknown: null }, "a correctly shipped proxy on Podman 4.9 is current");
	assert.deepEqual(parseProxyState(shape(PODMAN_49_NO_ENTRYPOINT)).entrypoint, []);
	assert.deepEqual(parseProxyState(shape('{"entrypoint":null,"cmd":"squid -N"}')).entrypoint, []);
	assert.deepEqual(parseProxyState(shape('{"entrypoint":null,"cmd":"squid -N"}')).cmd, ["squid -N"]);
	assert.equal(parseProxyState(shape('{"entrypoint":7}')).entrypoint, null, "a shape no runtime renders is no argv, and stale");
});

test("Podman's Docker API and native inspect, measured: the shipped proxy's shape, and its deleted folder is stale on Linux (#453 gate 3)", () => {
	for (const [label, raw] of [["compat", MEASURED_PODMAN_COMPAT], ["native", MEASURED_PODMAN_NATIVE]]) {
		const state = parseProxyState(raw);
		assert.equal(state.status, "exited", label);
		assert.equal(state.health, "none", `${label}: "" is no healthcheck`);
		assert.deepEqual([state.entrypoint, state.cmd], [[...EGRESS_PROXY_ENTRYPOINT], [...EGRESS_PROXY_CMD]], label);
		// Judged where the folder exists (its paths resolved as a host holding it would), it is current.
		assert.deepEqual(shippedProxyDrift(state, { cwd: "/home/op/pi-dispatch", realpath: (p) => p }), { drift: [], unknown: null }, label);
		// Judged on that Linux host after the folder was deleted: gone, so stale, never unknown.
		const gone = shippedProxyDrift(state, {
			cwd: "/home/op/pi-dispatch",
			platform: "linux",
			realpath: (p) => {
				throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			},
		});
		assert.equal(gone.unknown, null, label);
		assert.ok(gone.drift.includes("its /etc/pi-dispatch/allowlist.conf is /home/op/pi-dispatch/egress-allowlist.conf, which does not exist on this host"), `${label}: ${gone.drift.join(" | ")}`);
	}
});

test("the same measured proxy judged from another folder, and where a source cannot be resolved: unknown only for a VM path or a macOS/Windows host (#453 gates 2 and 3)", () => {
	const state = parseProxyState(MEASURED_COMPOSE);
	const elsewhere = shippedProxyDrift(state, { cwd: "/srv/other", realpath });
	assert.deepEqual(elsewhere.drift, ["its /etc/squid/squid.conf is /var/tmp/m453/dep/deploy/egress-proxy.conf, not /srv/other/deploy/egress-proxy.conf", "its /etc/pi-dispatch/allowlist.conf is /var/tmp/m453/dep/egress-allowlist.conf, not /srv/other/egress-allowlist.conf"]);
	const nothing = (p) => {
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	};
	for (const platform of ["darwin", "win32"]) {
		const off = shippedProxyDrift(state, { cwd: "/var/tmp/m453/dep", platform, realpath: nothing });
		assert.deepEqual(off.drift, [], `${platform}: unknown is never stale`);
		assert.match(off.unknown, /^\/var\/tmp\/m453\/dep\/deploy\/egress-proxy\.conf, \/var\/tmp\/m453\/dep\/egress-allowlist\.conf are paths this host cannot resolve/, platform);
	}
	const desktop = { ...state, mounts: state.mounts.map((m) => (m.type === "bind" ? { ...m, source: `/host_mnt${m.source}` } : m)) };
	assert.match(shippedProxyDrift(desktop, { cwd: "/var/tmp/m453/dep", platform: "linux", realpath: nothing }).unknown, /^\/host_mnt\/var\/tmp\/m453\/dep\/deploy\/egress-proxy\.conf, \/host_mnt\/var\/tmp\/m453\/dep\/egress-allowlist\.conf are paths /, "a Desktop VM prefix is unknown even judged as Linux");
	const wsl = { ...state, mounts: state.mounts.map((m) => (m.type === "bind" ? { ...m, source: `/run/desktop/mnt/host/c${m.source}` } : m)) };
	assert.ok(shippedProxyDrift(wsl, { cwd: "/var/tmp/m453/dep", platform: "linux", realpath: nothing }).unknown);
	// Each bind on its own (round-cap re-review): one under a VM prefix is unknown, the other gone bind and an extra mount
	// are still drift.
	const mixed = { ...state, mounts: [...state.mounts.map((m) => (m.destination === "/etc/squid/squid.conf" ? { ...m, source: `/host_mnt${m.source}` } : m)), { type: "bind", source: "/host_mnt/tmp/open.conf", destination: "/tmp/open.conf" }] };
	const judgedMixed = shippedProxyDrift(mixed, { cwd: "/var/tmp/m453/dep", platform: "linux", realpath: nothing });
	assert.match(judgedMixed.unknown, /^\/host_mnt\/var\/tmp\/m453\/dep\/deploy\/egress-proxy\.conf is a path this host cannot resolve/);
	assert.deepEqual(judgedMixed.drift, ["its /etc/pi-dispatch/allowlist.conf is /var/tmp/m453/dep/egress-allowlist.conf, which does not exist on this host", "it has a bind at /tmp/open.conf (from /host_mnt/tmp/open.conf) that the shipped proxy does not"]);
	const linuxGone = shippedProxyDrift(state, { cwd: "/var/tmp/m453/dep", platform: "linux", realpath: nothing });
	assert.equal(linuxGone.unknown, null, "on Linux a source that does not resolve is gone");
	assert.equal(linuxGone.drift.length, 2);
});
