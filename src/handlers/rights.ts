import type { ChatMember } from "grammy/types";
import type { Rights } from "../db/chats.js";
export function memberRights(member: ChatMember): Rights {
  return {
    admin: member.status === "administrator" || member.status === "creator",
    deleteMessages:
      member.status === "creator" ||
      (member.status === "administrator" && member.can_delete_messages),
    restrictMembers:
      member.status === "creator" ||
      (member.status === "administrator" && member.can_restrict_members),
  };
}
export function rightsSummary(rights: Rights, type: string): string {
  const missing = [
    !rights.admin && "admin",
    !rights.deleteMessages && "delete messages",
    !rights.restrictMembers && "restrict members",
  ].filter(Boolean);
  return (
    (missing.length
      ? "Missing rights: " + missing.join(", ") + "."
      : "R9K is active.") +
    (type !== "supergroup"
      ? " Muting needs a supergroup; penalties here stop at deletion."
      : "")
  );
}
