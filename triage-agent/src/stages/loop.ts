export type LoopDecision = "done" | "retry" | "exhausted";

/**
 * Bounded fix loop: the WorkflowTemplate recurses into another implement
 * attempt only on "retry", so attempts never exceed maxAttempts.
 */
export function loopDecision(
  ok: boolean,
  attempt: number,
  maxAttempts: number,
): LoopDecision {
  if (ok) return "done";
  return attempt < maxAttempts ? "retry" : "exhausted";
}
