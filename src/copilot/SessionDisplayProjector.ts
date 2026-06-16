import type { CopilotSession } from "./types.js";

/**
 * Projects raw CopilotSession columns into the display fields the
 * left sidebar renders directly:
 *
 *   - displayTitle    — what the sidebar shows on the first line
 *   - displaySubtitle — secondary line (lead label · relative time)
 *   - sessionType     — coarse classification used by the UI for icons / status dots
 *   - displayStatus   — high-level state derived from session.status
 *
 * The frontend is forbidden from inferring titles from message bodies
 * or running its own keyword heuristics; this module is the single
 * source of truth so `/copilot/sessions` and `/copilot/sidebar` always
 * return ready-to-render strings.
 *
 * No database column is added — projector runs on the row mapping path
 * (toSession in Postgres, repo CRUD outputs in InMemory).
 */

const DEFAULT_TITLE_TOKENS = new Set([
  "new copilot chat",
  "new chat",
  "untitled",
  "untitled session",
  "新对话",
  "新会话",
  "新任务",
  "未命名",
  "未命名会话",
  "未命名对话",
]);

export type SessionDisplayType =
  | "jd_analysis"
  | "resume_rewrite"
  | "resume_generate"
  | "experience_intake"
  | "workspace_task"
  | "chat";

export type SessionDisplayStatus =
  | "active"
  | "running"
  | "needs_input"
  | "completed"
  | "archived";

const SESSION_TYPE_LABELS: Record<SessionDisplayType, string> = {
  jd_analysis: "JD 分析",
  resume_rewrite: "简历改写",
  resume_generate: "简历生成",
  experience_intake: "经历入库",
  workspace_task: "工作区任务",
  chat: "对话",
};

export function isDefaultTitle(title?: string | null): boolean {
  if (!title) return true;
  const trimmed = String(title).trim().toLowerCase();
  if (!trimmed) return true;
  return DEFAULT_TITLE_TOKENS.has(trimmed);
}

function relativeTime(updatedAt: string, now: number = Date.now()): string {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return "";
  const diff = Math.max(0, now - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 4 * hour) return `${Math.floor(diff / hour)} 小时前`;

  const updated = new Date(ts);
  const today = new Date(now);
  const sameDay =
    updated.getFullYear() === today.getFullYear()
    && updated.getMonth() === today.getMonth()
    && updated.getDate() === today.getDate();

  if (sameDay) {
    const hh = String(updated.getHours()).padStart(2, "0");
    const mm = String(updated.getMinutes()).padStart(2, "0");
    return `今天 ${hh}:${mm}`;
  }

  if (diff < 2 * day) return "昨天";
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;

  const month = String(updated.getMonth() + 1).padStart(2, "0");
  const day2 = String(updated.getDate()).padStart(2, "0");
  return `${month}-${day2}`;
}

function classifySession(session: CopilotSession): SessionDisplayType {
  if (session.targetRole && String(session.targetRole).trim()) return "jd_analysis";
  if (session.currentWorkspaceId) return "workspace_task";
  return "chat";
}

function classifyStatus(session: CopilotSession): SessionDisplayStatus {
  if (session.status === "archived") return "archived";
  if (session.status === "deleted") return "archived";
  return "active";
}

/**
 * Truncate a display string at a UI-friendly length while keeping
 * Chinese characters intact.
 */
function truncate(value: string, max: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

export function deriveSessionDisplay(session: CopilotSession, now: number = Date.now()): {
  displayTitle: string;
  displaySubtitle: string;
  sessionType: SessionDisplayType;
  displayStatus: SessionDisplayStatus;
} {
  const sessionType = classifySession(session);
  const displayStatus = classifyStatus(session);
  const time = relativeTime(session.updatedAt, now);

  const userTitle = (session.title ?? "").trim();
  const targetRole = (session.targetRole ?? "").trim();
  const typeLabel = SESSION_TYPE_LABELS[sessionType];

  // 1) User-renamed title wins.
  if (userTitle && !isDefaultTitle(userTitle)) {
    return {
      displayTitle: truncate(userTitle, 28),
      displaySubtitle: time ? `${typeLabel} · ${time}` : typeLabel,
      sessionType,
      displayStatus,
    };
  }

  // 2) targetRole drives a JD-flavored title.
  if (targetRole) {
    return {
      displayTitle: truncate(`${targetRole} · JD 匹配`, 28),
      displaySubtitle: time ? `${typeLabel} · ${time}` : typeLabel,
      sessionType,
      displayStatus,
    };
  }

  // 3) Active workspace without role — generic workspace task.
  if (session.currentWorkspaceId) {
    return {
      displayTitle: "工作区任务",
      displaySubtitle: time ? `${typeLabel} · ${time}` : typeLabel,
      sessionType,
      displayStatus,
    };
  }

  // 4) Default — never the literal "New Copilot chat".
  return {
    displayTitle: "新的对话",
    displaySubtitle: time ? `${typeLabel} · ${time}` : typeLabel,
    sessionType: "chat",
    displayStatus,
  };
}

/**
 * Returns a copy of the session with the four display fields filled in.
 * Safe to apply to every session that crosses an API or UI boundary.
 */
export function applySessionDisplay<T extends CopilotSession>(session: T, now: number = Date.now()): T {
  const derived = deriveSessionDisplay(session, now);
  return {
    ...session,
    displayTitle: derived.displayTitle,
    displaySubtitle: derived.displaySubtitle,
    sessionType: derived.sessionType,
    displayStatus: derived.displayStatus,
  };
}
