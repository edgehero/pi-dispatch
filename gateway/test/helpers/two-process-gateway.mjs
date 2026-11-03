/** One real gateway process for two-process.test.mjs. Server, store and sockets are the real ones; only the
 * container runtime is a fake, because what is under test is what two processes share, which is only the store. */
import { Duplex, Readable } from "node:stream";
import { makeRedisClient } from "../../../worker/src/connection.mjs";
import { makeGatewayStore } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { createGatewayServer } from "../../src/server.mjs";
import { makeGatewayAudit } from "../../src/audit.mjs";

const { url, prefix, origin, consoleOrigin, host, logsDir } = JSON.parse(process.env.TWO_PROCESS_GATEWAY);
const report = (type, value = {}) => process.send({ type, ...value });
const outputs = new Set();
const runtime = {
	inspect: async () => ({ ok: true }),
	attach: async (_target, { cols, rows }) => {
		report("attach", { cols, rows });
		const stream = new Duplex({ read() {}, write(chunk, _encoding, done) { report("input", { data: chunk.toString() }); done(); } });
		outputs.add(stream);
		return { stream, detach() { outputs.delete(stream); stream.destroy(); }, resize: async geometry => report("resize", { cols: geometry.cols, rows: geometry.rows }) };
	},
	// The production adapter hands a watch only a Readable. The fake keeps that shape, so a dropped frame
	// that somehow reached the stream would throw here instead of quietly counting as input.
	attachWatch: async () => {
		report("attachWatch");
		const stream = new Readable({ read() {} });
		outputs.add(stream);
		return { stream, detach() { outputs.delete(stream); stream.destroy(); } };
	},
};
const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
const journal = makeGatewayAudit({ logsDir }); journal.recover();
const app = createGatewayServer({ config: { origin, consoleOrigin, host, sockets: { local: "/fixed.sock" }, idleMinutes: 30 }, store: makeGatewayStore({ redis, prefix }), runtime, assets: { script: "", terminalScript: "", css: "" }, audit: (...values) => journal.record(...values) });
app.server.listen(0, "127.0.0.1", () => report("listening", { port: app.server.address().port }));
process.on("message", message => {
	if (message.cmd === "output") for (const stream of outputs) stream.push(Buffer.from(message.data));
});
process.on("disconnect", () => process.exit(0));
