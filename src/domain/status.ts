/**
 * Assignment and verification status machines (SPEC §5.1, §5.4).
 *
 * Assignment (stored statuses only — `overdue` is derived, see `./dates.ts`):
 *
 * ```text
 *   active ──report──▶ in_review ──approve──▶ done (terminal)
 *      ▲                   │
 *      └─────dismiss───────┘
 * ```
 *
 * **Decision (not described in SPEC §5.1, fixed here as the MVP default):** a dismissed
 * verification returns the assignment from `in_review` back to `active`. Rationale: the parent
 * rejected the AI verdict, not the child's work; the report stays on record and can be amended
 * with more photos or re-reported. The alternative — jumping straight to `done` — would silently
 * mark rejected homework as accepted, and `active` is the only stored state that keeps the
 * assignment in the reminder/digest loop.
 *
 * Verification: `draft ──approve──▶ approved`, `draft ──dismiss──▶ dismissed`; both terminal.
 * A recomputed verification (photos added before approval) is a new `draft` row, not a rollback.
 */

import { InvalidTransitionError } from "./errors.js";
import type { AssignmentStatus, VerificationStatus } from "./types.js";

/** Parent-facing actions that change an assignment status. */
export type AssignmentAction = "report" | "approve" | "dismiss";

/** Parent-facing actions that decide a verification. */
export type VerificationAction = "approve" | "dismiss";

export interface AssignmentTransition {
  from: AssignmentStatus;
  action: AssignmentAction;
  to: AssignmentStatus;
}

/** The complete assignment status machine. */
export const ASSIGNMENT_TRANSITIONS: readonly AssignmentTransition[] = [
  { from: "active", action: "report", to: "in_review" },
  { from: "in_review", action: "approve", to: "done" },
  { from: "in_review", action: "dismiss", to: "active" },
];

/** Status after `action`, or `null` when the action is not allowed from `from`. */
export function nextAssignmentStatus(
  from: AssignmentStatus,
  action: AssignmentAction,
): AssignmentStatus | null {
  const transition = ASSIGNMENT_TRANSITIONS.find((t) => t.from === from && t.action === action);
  return transition ? transition.to : null;
}

/** Whether `action` is allowed in `from`. */
export function canApplyAssignmentAction(from: AssignmentStatus, action: AssignmentAction): boolean {
  return nextAssignmentStatus(from, action) !== null;
}

/**
 * Apply `action`, throwing {@link InvalidTransitionError} when it is not allowed.
 * Repositories call this so both the SQLite store and the in-memory fakes enforce one machine.
 */
export function applyAssignmentAction(
  from: AssignmentStatus,
  action: AssignmentAction,
): AssignmentStatus {
  const next = nextAssignmentStatus(from, action);
  if (next === null) {
    throw new InvalidTransitionError(
      `Cannot ${action} an assignment in status "${from}" (allowed: ${ASSIGNMENT_TRANSITIONS.filter((t) => t.from === from)
        .map((t) => t.action)
        .join(", ") || "nothing"})`,
    );
  }
  return next;
}

/** `done` is the only terminal assignment status in the MVP. */
export function isTerminalAssignmentStatus(status: AssignmentStatus): boolean {
  return status === "done";
}

export interface VerificationTransition {
  from: VerificationStatus;
  action: VerificationAction;
  to: VerificationStatus;
}

/** The complete verification status machine. */
export const VERIFICATION_TRANSITIONS: readonly VerificationTransition[] = [
  { from: "draft", action: "approve", to: "approved" },
  { from: "draft", action: "dismiss", to: "dismissed" },
];

/** Status after `action`, or `null` when the action is not allowed from `from`. */
export function nextVerificationStatus(
  from: VerificationStatus,
  action: VerificationAction,
): VerificationStatus | null {
  const transition = VERIFICATION_TRANSITIONS.find((t) => t.from === from && t.action === action);
  return transition ? transition.to : null;
}

/** Whether `action` is allowed in `from`. */
export function canDecideVerification(from: VerificationStatus, action: VerificationAction): boolean {
  return nextVerificationStatus(from, action) !== null;
}

/** Apply `action`, throwing {@link InvalidTransitionError} when it is not allowed. */
export function applyVerificationAction(
  from: VerificationStatus,
  action: VerificationAction,
): VerificationStatus {
  const next = nextVerificationStatus(from, action);
  if (next === null) {
    throw new InvalidTransitionError(`Verification in status "${from}" cannot: ${action}`);
  }
  return next;
}

/** Only drafts wait for a parent decision. */
export function isAwaitingDecision(status: VerificationStatus): boolean {
  return status === "draft";
}
