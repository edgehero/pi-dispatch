import { readConsumerDemand } from "./bullmq-internals.mjs";
import { consumerHealthOf, parseConsumerHealth, CONSUMER_STALE_MS } from "./consumer-health.mjs";
import { QUEUE, hostQueueName } from "./queue.mjs";
import { WORKER_NAME_RE, sandboxPrepareQueueName } from "./worker-name.mjs";

export const CONSUMER_READ_TIMEOUT_MS = 2000;
export const CONSUMER_READ_QUEUES_MAX = 64;

/** Same queue mapping for every reader. A shared backlog belongs to the shared consumer, never a host queue. */
export function consumerQueueName(host, role) {
	if (!WORKER_NAME_RE.test(host ?? "")) return null;
	return role === "shared" ? QUEUE : role === "host" ? hostQueueName(host) : role === "sandbox" ? sandboxPrepareQueueName(host) : null;
}

/** One bounded read per distinct queue, sharing one deadline. Failure/missing rows retain an explicit unknown. */
export async function readConsumerStatus(redis, hosts, { now = Date.now, timeoutMs = CONSUMER_READ_TIMEOUT_MS } = {}) {
	const names = new Set();
	for (const h of hosts.slice(0, CONSUMER_READ_QUEUES_MAX)) for (const c of parseConsumerHealth(h) ?? []) {
		const name = consumerQueueName(h.name, c.role);
		if (name && names.size < CONSUMER_READ_QUEUES_MAX) names.add(name);
	}
	const demand = new Map();
	const at = now();
	let timer, open = true;
	try {
		await Promise.race([
			Promise.all([...names].map(async (name) => {
				try {
					const result = await readConsumerDemand(redis, name, { now: at, graceMs: CONSUMER_STALE_MS });
					if (open) demand.set(name, result);
				} catch { /* An unanswered queue cannot corroborate a stall. */ }
			})),
			new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
		]);
	} finally { open = false; clearTimeout(timer); }
	return hosts.map((h) => {
		const byRole = Object.fromEntries((parseConsumerHealth(h) ?? []).map((c) => [c.role, demand.get(consumerQueueName(h.name, c.role))]));
		const health = consumerHealthOf(h, byRole);
		return { name: h.name, ...health, rows: health.rows.map((c) => ({ ...c, queue: consumerQueueName(h.name, c.role) })) };
	});
}
