import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";
import { formatTaskOverview, getAgentTaskOverview } from "./task-overview.js";

export const handleTasksCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/tasks" && !normalized.startsWith("/tasks ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /tasks from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const arg = normalized.slice("/tasks".length).trim() || undefined;
  const overviews = getAgentTaskOverview(arg);
  const text = formatTaskOverview(overviews);
  return { shouldContinue: false, reply: { text } };
};
