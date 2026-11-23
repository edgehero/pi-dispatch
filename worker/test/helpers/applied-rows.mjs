// The `applied` rows of an allocation audit that stand for a write that happened (issue #1065). `applyPlan` writes its
// `applied` row before the compare-and-set, since a change that happened must always have its row, and an
// `apply-failed` row after it when the CAS lost to a state written meanwhile. An apply that read the state, then took
// the lock right after another apply released it, therefore leaves both rows; an `applied` row that a later
// `apply-failed` row of the same host and plan follows is a write that did not happen.
export function appliedThatLanded(rows) {
	return rows.filter((row, at) => row.outcome === "applied" && !rows.some((later, i) => i > at && later.outcome === "apply-failed" && later.host === row.host && later.planId === row.planId));
}
