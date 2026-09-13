/**
 * Safety guards for money-moving writes.
 *
 * Two rules, both enforced server-side so no client prompt can skip them:
 *   1. A hard cap from the environment (MAX_DAILY_BUDGET_CENTS /
 *      MAX_LIFETIME_BUDGET_CENTS). Anything above is refused, full stop.
 *   2. Raising a budget on an existing campaign / ad set needs
 *      `confirm_budget_increase: true`. Lowering never does.
 */

export type BudgetKind = "daily" | "lifetime";

export interface BudgetCheck {
  kind: BudgetKind;
  /** Current budget in cents; undefined when creating a new object. */
  currentCents?: number;
  requestedCents: number;
  /** The caller passed confirm_budget_increase=true. */
  confirm: boolean;
  /** Hard cap from config; undefined = no cap. */
  capCents?: number;
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function parseCents(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Throws with an actionable message when the change is not allowed.
 */
export function assertBudgetChangeAllowed(check: BudgetCheck): void {
  const label = check.kind === "daily" ? "daily" : "lifetime";
  const envName = check.kind === "daily" ? "MAX_DAILY_BUDGET_CENTS" : "MAX_LIFETIME_BUDGET_CENTS";

  if (check.capCents !== undefined && check.requestedCents > check.capCents) {
    throw new Error(
      `Refused: requested ${label} budget ${formatCents(check.requestedCents)} exceeds the hard cap ` +
        `${formatCents(check.capCents)} configured by the operator (${envName}). ` +
        "The cap cannot be overridden from a conversation."
    );
  }

  if (
    check.currentCents !== undefined &&
    check.requestedCents > check.currentCents &&
    !check.confirm
  ) {
    throw new Error(
      `Refused: raising the ${label} budget from ${formatCents(check.currentCents)} to ` +
        `${formatCents(check.requestedCents)} needs explicit approval. Ask the user to confirm the ` +
        "increase, then call again with confirm_budget_increase=true."
    );
  }
}
