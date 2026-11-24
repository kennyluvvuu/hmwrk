import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "./errors.js";
import {
  ASSIGNMENT_TRANSITIONS,
  VERIFICATION_TRANSITIONS,
  applyAssignmentAction,
  applyVerificationAction,
  canApplyAssignmentAction,
  canDecideVerification,
  isAwaitingDecision,
  isTerminalAssignmentStatus,
  nextAssignmentStatus,
  nextVerificationStatus,
} from "./status.js";
import { ASSIGNMENT_STATUSES, VERIFICATION_STATUSES } from "./types.js";

describe("assignment status machine (SPEC §5.1)", () => {
  it("walks the full flow active → in_review → done", () => {
    const inReview = applyAssignmentAction("active", "report");
    expect(inReview).toBe("in_review");
    expect(applyAssignmentAction(inReview, "approve")).toBe("done");
  });

  it("returns a dismissed report to active (documented MVP default)", () => {
    expect(applyAssignmentAction("in_review", "dismiss")).toBe("active");
  });

  it("forbids skipping states", () => {
    expect(nextAssignmentStatus("active", "approve")).toBeNull();
    expect(nextAssignmentStatus("active", "dismiss")).toBeNull();
    expect(nextAssignmentStatus("done", "report")).toBeNull();
    expect(() => applyAssignmentAction("active", "approve")).toThrow(InvalidTransitionError);
    expect(() => applyAssignmentAction("done", "report")).toThrow(InvalidTransitionError);
  });

  it("exposes the table for tool-side checks", () => {
    expect(ASSIGNMENT_TRANSITIONS).toHaveLength(3);
    expect(canApplyAssignmentAction("in_review", "approve")).toBe(true);
    expect(canApplyAssignmentAction("done", "approve")).toBe(false);
  });

  it("treats done as the only terminal status", () => {
    expect(ASSIGNMENT_STATUSES.filter(isTerminalAssignmentStatus)).toEqual(["done"]);
  });

  it("mentions the allowed actions in the error message", () => {
    try {
      applyAssignmentAction("done", "approve");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).code).toBe("invalid_transition");
      expect((error as Error).message).toContain("nothing");
    }
  });
});

describe("verification status machine (SPEC §5.4)", () => {
  it("only accepts a decision on a draft", () => {
    expect(applyVerificationAction("draft", "approve")).toBe("approved");
    expect(applyVerificationAction("draft", "dismiss")).toBe("dismissed");
    expect(nextVerificationStatus("approved", "dismiss")).toBeNull();
    expect(() => applyVerificationAction("approved", "approve")).toThrow(InvalidTransitionError);
    expect(() => applyVerificationAction("dismissed", "dismiss")).toThrow(InvalidTransitionError);
  });

  it("exposes the table and the awaiting-decision predicate", () => {
    expect(VERIFICATION_TRANSITIONS).toHaveLength(2);
    expect(VERIFICATION_STATUSES.filter(isAwaitingDecision)).toEqual(["draft"]);
    expect(canDecideVerification("draft", "approve")).toBe(true);
    expect(canDecideVerification("dismissed", "approve")).toBe(false);
  });
});
