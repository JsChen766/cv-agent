export const BLOCKED_TOOL_LOGS = [
  "Your experience library has",
  "No obvious unsupported claims found",
  "Found ",
  "Loaded JD",
  "Loaded experience",
  "Loaded resume",
  "Updated resume item",
  "Evidence loaded",
];

export function isBlockedToolLog(text: string): boolean {
  return BLOCKED_TOOL_LOGS.some((item) => text.includes(item));
}
