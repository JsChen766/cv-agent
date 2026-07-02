import type { ResumeDocument } from "../types.js";
import { ResumeDraftProjector, cloneResumeDocument } from "./ResumeDraftProjector.js";
import type { ResumeChangeSet } from "./types.js";

export class ResumePatchProjectionService {
  public constructor(private readonly draftProjector: ResumeDraftProjector = new ResumeDraftProjector()) {}

  public projectPatchedDraft(changeSet: ResumeChangeSet): ResumeDocument {
    return this.draftProjector.projectProposed(changeSet);
  }

  public projectAcceptedDraft(changeSet: ResumeChangeSet): ResumeDocument {
    return cloneResumeDocument(changeSet.currentDraft);
  }
}
