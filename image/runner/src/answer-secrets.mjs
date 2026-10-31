/** Reject known credential bytes rather than altering the meaning of a cited source (#772). */
export function knownAnswerSecretMatcher(env = process.env) {
	// Draft jobs have only worker-selected credential variables. Short flags/words are not secret material;
	// eight matches the existing host transcript redactor's floor. This is accident protection, not DLP.
	const needles = new Set();
	for (const [key, value] of Object.entries(env)) {
		if (!/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PAT)(?:_|$)/i.test(key) || typeof value !== "string" || value.length < 8) continue;
		const encoded = encodeURIComponent(value);
		for (const spelling of [value, JSON.stringify(value).slice(1, -1), encoded, encoded.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()), Buffer.from(value).toString("base64"), Buffer.from(`:${value}`).toString("base64")]) needles.add(spelling);
	}
	return value => typeof value === "string" && [...needles].some(needle => value.includes(needle));
}
