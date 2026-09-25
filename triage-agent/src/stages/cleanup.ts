import { rm } from "node:fs/promises";
import type { StageDeps } from "./context.ts";

/**
 * Exit-handler step: a succeeded workflow's workspace goes at once; a failed
 * one stays for debugging until the intake janitor's retention expires.
 */
export async function cleanupStage(deps: StageDeps): Promise<boolean> {
  const { config, work, logger } = deps;
  if (config.WORKFLOW_STATUS !== "Succeeded") {
    logger.info(
      { status: config.WORKFLOW_STATUS, workspace: work.root },
      "workspace kept for the janitor",
    );
    return false;
  }
  await rm(work.root, { recursive: true, force: true });
  logger.info({ workspace: work.root }, "workspace removed");
  return true;
}
