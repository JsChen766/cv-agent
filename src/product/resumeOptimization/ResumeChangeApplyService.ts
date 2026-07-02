import type { ResumeDocument } from "../types.js";
import type { ResumeChange, ResumeChangeSet } from "./types.js";
import { summarizeChanges } from "./ResumeChangePlanner.js";

export class ResumeChangeApplyService {
  public acceptChange(changeSet: ResumeChangeSet, changeId: string): ResumeChangeSet {
    return updateChangeSet(changeSet, (change) =>
      change.changeId === changeId && change.status === "pending"
        ? { ...change, status: "accepted" }
        : change,
    );
  }

  public acceptAll(changeSet: ResumeChangeSet): ResumeChangeSet {
    return updateChangeSet(changeSet, (change) =>
      change.status === "pending" ? { ...change, status: "accepted" } : change,
    );
  }
}

export function projectAcceptedDraft(changeSet: ResumeChangeSet): ResumeDocument {
  const document = cloneDocument(changeSet.originalDraft);
  const accepted = changeSet.changes.filter((change) => change.status === "accepted");
  for (const change of accepted) applyChange(document, change);
  pruneEmptyBullets(document);
  return document;
}

function applyChange(document: ResumeDocument, change: ResumeChange): void {
  const section = document.sections.find((item) => item.id === change.target.sectionId);
  const item = section?.items.find((entry) => entry.id === change.target.itemId);
  if (!section || !item) return;
  if (change.type === "remove_weak_item") {
    section.items = section.items.filter((entry) => entry.id !== change.target.itemId);
    return;
  }
  const bulletId = change.target.bulletId;
  const bullet = bulletId ? item.bullets.find((entry) => entry.id === bulletId) : undefined;
  if (bullet) {
    bullet.text = change.after;
    if (change.evidenceIds.length > 0) bullet.evidenceIds = [...change.evidenceIds];
    return;
  }
  if (change.after.trim()) {
    item.bullets.push({
      id: bulletId ?? `${item.id}-accepted-${item.bullets.length + 1}`,
      text: change.after,
      evidenceIds: change.evidenceIds,
    });
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

function pruneEmptyBullets(document: ResumeDocument): void {
  for (const section of document.sections) {
    for (const item of section.items) {
      item.bullets = item.bullets.filter((bullet) => bullet.text.trim().length > 0);
    }
  }
}

function cloneDocument(document: ResumeDocument): ResumeDocument {
  return {
    schemaVersion: 1,
    sections: document.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        bullets: item.bullets.map((bullet) => ({
          ...bullet,
          evidenceIds: bullet.evidenceIds ? [...bullet.evidenceIds] : undefined,
        })),
      })),
    })),
  };
}
