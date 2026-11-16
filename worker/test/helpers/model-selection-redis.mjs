/** Byte-comparing fake for state-machine tests; the real Lua is separately exercised against Valkey. */
export function modelSelectionRedis() {
	const store = new Map();
	const ttls = new Map();
	return {
		store, ttls,
		get: async (key) => store.get(key) ?? null,
		set: async (key, value) => { store.set(key, value); ttls.delete(key); return "OK"; },
		del: async (...keys) => { for (const key of keys) { store.delete(key); ttls.delete(key); } return keys.length; },
		incr: async (key) => { const next = Number(store.get(key) ?? 0) + 1; store.set(key, String(next)); return next; },
		decr: async (key) => { const next = Number(store.get(key) ?? 0) - 1; store.set(key, String(next)); return next; },
		expire: async () => 1,
		eval: async (_script, _count, key, expected, next, ttl = 0) => {
			if (key.startsWith("dispatch:model-cooldown:")) {
				if (JSON.parse(store.get(key) ?? "null")?.until > Number(expected)) return 0;
			} else if ((store.get(key) ?? "") !== expected) return 0;
			store.set(key, next);
			if (Number(ttl) > 0) ttls.set(key, Number(ttl)); else ttls.delete(key);
			return 1;
		},
	};
}
