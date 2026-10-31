/** Host-only control flow for a determinate, free subscription admission delay. Never queued authority. */
export class SubscriptionWait extends Error {
	constructor({ wait, until }) {
		if (!["subscription-auth", "subscription-quota", "subscription-owner"].includes(wait) || !Number.isSafeInteger(until) || until < 0 || until > 253_402_300_799_999) throw new TypeError("invalid subscription admission wait");
		super("subscription admission must wait");
		this.name = "SubscriptionWait";
		this.wait = wait;
		this.until = until;
		this.budgetReserved = false;
	}
}
