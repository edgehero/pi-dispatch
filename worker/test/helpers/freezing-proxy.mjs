import { connect as netConnect, createServer } from "node:net";

/**
 * A loopback proxy to the real Valkey that can stop passing bytes either way and later pass what it held, in order: a
 * `kill -STOP` and a `kill -CONT` of that Valkey as one client sees them, without a Valkey process of the test's own.
 */
export async function freezingProxy(target) {
	const to = new URL(target);
	let frozen = false;
	const held = [];
	const sockets = new Set();
	const server = createServer((client) => {
		const upstream = netConnect({ host: to.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(to.port || 6379) });
		for (const s of [client, upstream]) {
			sockets.add(s);
			s.on("error", () => {});
		}
		client.on("data", (data) => (frozen ? held.push([upstream, data]) : upstream.write(data)));
		upstream.on("data", (data) => (frozen ? held.push([client, data]) : client.write(data)));
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const via = new URL(target);
	via.hostname = "127.0.0.1";
	via.port = String(server.address().port);
	return {
		url: via.toString(),
		freeze: () => (frozen = true),
		thaw: () => {
			frozen = false;
			for (const [socket, data] of held.splice(0)) socket.write(data);
		},
		close: () => {
			for (const s of sockets) s.destroy();
			server.close();
		},
	};
}
