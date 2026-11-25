import type { Folder, MessageSummary } from "../../shared/types";
import { api } from "../api";

export interface MessagePatch {
  isRead?: boolean;
  isStarred?: boolean;
  folder?: Folder;
  addLabels?: string[];
  removeLabels?: string[];
}

export function applyPatch(message: MessageSummary, patch: MessagePatch): MessageSummary {
  let labelIds = message.labelIds;
  if (patch.addLabels) labelIds = [...new Set([...labelIds, ...patch.addLabels])];
  if (patch.removeLabels) labelIds = labelIds.filter((id) => !patch.removeLabels!.includes(id));
  return {
    ...message,
    isRead: patch.isRead ?? message.isRead,
    isStarred: patch.isStarred ?? message.isStarred,
    folder: patch.folder ?? message.folder,
    labelIds,
  };
}

export function patchMessages(ids: string[], patch: MessagePatch): Promise<unknown> {
  return api("/api/messages", { method: "PATCH", body: { ids, ...patch } });
}
