import { rmSync } from "node:fs";
import { implementStage, planStage, triageStage } from "./agent.ts";
import { ciWatchStage } from "./ci.ts";
import type { StageDeps } from "./context.ts";
import { commitStage, needsHumanStage, prStage } from "./github.ts";
import { argocdSyncStage, notifyStage } from "./notify.ts";
import { verifyStage } from "./verify.ts";

export const STAGES = {
  triage: triageStage,
  plan: planStage,
  implement: implementStage,
  verify: verifyStage,
  commit: commitStage,
  pr: prStage,
  "ci-watch": ciWatchStage,
  "needs-human": needsHumanStage,
  notify: notifyStage,
  "argocd-sync": argocdSyncStage,
} satisfies Record<string, (deps: StageDeps) => Promise<unknown>>;

export type StageName = keyof typeof STAGES;

export function isStageName(name: string): name is StageName {
  return Object.hasOwn(STAGES, name);
}

export async function runStage(
  name: StageName,
  deps: StageDeps,
): Promise<void> {
  rmSync(deps.work.path("out"), { recursive: true, force: true });
  await STAGES[name](deps);
}
