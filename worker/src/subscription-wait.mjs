/** Host-only control flow for a determinate, free subscription admission delay. Never queued authority. */
export class SubscriptionWait extends Error {
	constructor({ wait, until, status = null, auxiliary = false, resetAt = null }) {
		if (!["subscription-auth", "subscription-quota", "subscription-owner", "subscription-reserve"].includes(wait) || !Number.isSafeInteger(until) || until < 0 || until > 253_402_300_799_999) throw new TypeError("invalid subscription admission wait");
		super("subscription admission must wait");
		this.name = "SubscriptionWait";
		this.wait = wait;
		this.until = until;
		// Issue #1008: the quota reserve names the latest reset of the windows that hold it (its status is not exhausted,
		// so the status has none); an exhausted status names its own.
		this.resetAt = Number.isSafeInteger(resetAt) ? resetAt : Number.isSafeInteger(status?.until) ? status.until : null;
		this.budgetReserved = false;
		this.quotaConfirmed = wait === "subscription-quota" && status?.state === "exhausted" && status.bindingValid !== false;
		// A panel provider's exhaustion cannot grant the selected root a fresh random draw.
		this.auxiliary = auxiliary === true;
	}
}
