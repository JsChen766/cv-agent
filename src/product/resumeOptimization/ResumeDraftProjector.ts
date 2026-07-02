import type { ResumeDocument } from "../types.js";
import type { ResumeChangeSet } from "./types.js";

export class ResumeDraftProjector {
  public projectOriginal(changeSet: ResumeChangeSet): ResumeDocument {
    return cloneDocument(changeSet.originalDraft);
  }

  public projectCurrent(changeSet: ResumeChangeSet): ResumeDocument {
    return cloneDocument(changeSet.currentDraft);
  }

  public projectProposed(changeSet: ResumeChangeSet): ResumeDocument {
    return cloneDocument(changeSet.proposedDraft);
  }
}

export function cloneResumeDocument(document: ResumeDocument): ResumeDocument {
  return cloneDocument(document);
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
