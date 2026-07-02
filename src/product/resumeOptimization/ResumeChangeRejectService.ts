import type { ResumeChange, ResumeChangeSet } from "./types.js";
import { projectAcceptedDraft } from "./ResumeChangeApplyService.js";
import { summarizeChanges } from "./ResumeChangePlanner.js";

export class ResumeChangeRejectService {
  public rejectChange(changeSet: ResumeChangeSet, changeId: string): ResumeChangeSet {
    return updateChangeSet(changeSet, (change) =>
      change.changeId === changeId && change.status === "pending"
        ? { ...change, status: "rejected" }
        : change,
    );
  }

  public rejectAll(changeSet: ResumeChangeSet): ResumeChangeSet {
    return updateChangeSet(changeSet, (change) =>
      change.status === "pending" ? { ...change, status: "rejected" } : change,
    );
  }
}

function updateChangeSet(
  changeSet: ResumeChangeSet,
  updater: (change: ResumeChange) => ResumeChange,
): ResumeChangeSet {
  const changes = changeSet.changes.map(updater);
  return {
    ...changeSet,
    changes,
    currentDraft: projectAcceptedDraft({ ...changeSet, changes }),
    status: statusFor(changes),
    summary: summarizeChanges(changes),
    updatedAt: new Date().toISOString(),
  };
}

function statusFor(changes: ResumeChange[]): ResumeChangeSet["status"] {
  const accepted = changes.filter((change) => change.status === "accepted").length;
  const rejected = changes.filter((change) => change.status === "rejected").length;
  if (changes.length > 0 && accepted === changes.length) return "accepted";
  if (changes.length > 0 && rejected === changes.length) return "rejected";
  if (accepted > 0 || rejected > 0) return "partially_accepted";
  return "pending";
}
