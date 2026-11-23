import { connect as netConnect, createServer } from "node:net";

/**
 * A loopback proxy to the real Valkey that can stop passing bytes either way and later pass what it held, in order: a
 * `kill -STOP` and a `kill -CONT` of that Valkey as one client sees them, without a Valkey process of the test's own.
 *
 * `holdFrom` (a command name, such as "SCAN"): a connection that sends that command has it and everything it sends after
 * it held, until `thaw()`, while every other connection is answered: one command that does not finish, and Valkey
 * answering one connection's commands in order, as a client of that connection sees them.
 */
export async function freezingProxy(target, { holdFrom = null } = {}) {
	const to = new URL(target);
	let frozen = false;
	const held = [];
	const sockets = new Set();
	const holds = new Set();
	// The command as a client writes it in RESP, its name as an argument of the array: `$4\r\nscan\r\n`, in any case.
	const named = holdFrom === null ? null : new RegExp(`\\*\\d+\\r\\n\\$${holdFrom.length}\\r\\n${holdFrom}\\r\\n`, "i");
	const server = createServer((client) => {
		const upstream = netConnect({ host: to.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(to.port || 6379) });
		for (const s of [client, upstream]) {
			sockets.add(s);
			s.on("error", () => {});
		}
		const hold = { on: false };
		holds.add(hold);
		client.on("data", (data) => {
			if (named !== null && !hold.on && !frozen) {
				// What came before the command in the same chunk is passed; the command and the rest are held.
				const at = named.exec(data.toString("latin1"))?.index ?? -1;
				if (at >= 0) {
					hold.on = true;
					if (at > 0) upstream.write(data.subarray(0, at));
					held.push([upstream, data.subarray(at)]);
					return;
				}
			}
			frozen || hold.on ? held.push([upstream, data]) : upstream.write(data);
		});
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
			for (const hold of holds) hold.on = false;
			for (const [socket, data] of held.splice(0)) socket.write(data);
		},
		close: () => {
			for (const s of sockets) s.destroy();
			server.close();
		},
	};
}
