import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBudgetChangeAllowed, parseCents } from "../src/lib/guards.js";

test("lowering a budget needs no confirmation", () => {
  assert.doesNotThrow(() =>
    assertBudgetChangeAllowed({ kind: "daily", currentCents: 1000, requestedCents: 500, confirm: false })
  );
});

test("raising a budget without confirmation is refused with an actionable message", () => {
  assert.throws(
    () => assertBudgetChangeAllowed({ kind: "daily", currentCents: 500, requestedCents: 1000, confirm: false }),
    /confirm_budget_increase=true/
  );
});

test("raising a budget with confirmation passes", () => {
  assert.doesNotThrow(() =>
    assertBudgetChangeAllowed({ kind: "daily", currentCents: 500, requestedCents: 1000, confirm: true })
  );
});

test("the hard cap wins even with confirmation", () => {
  assert.throws(
    () =>
      assertBudgetChangeAllowed({
        kind: "lifetime",
        currentCents: 500,
        requestedCents: 100_000,
        confirm: true,
        capCents: 50_000,
      }),
    /MAX_LIFETIME_BUDGET_CENTS/
  );
});

test("creating a new object only checks the cap", () => {
  assert.doesNotThrow(() =>
    assertBudgetChangeAllowed({ kind: "daily", requestedCents: 5000, confirm: false, capCents: 10_000 })
  );
  assert.throws(() =>
    assertBudgetChangeAllowed({ kind: "daily", requestedCents: 50_000, confirm: false, capCents: 10_000 })
  );
});

test("parseCents accepts Graph's string budgets", () => {
  assert.equal(parseCents("1500"), 1500);
  assert.equal(parseCents(1500), 1500);
  assert.equal(parseCents(undefined), undefined);
  assert.equal(parseCents(""), undefined);
});
