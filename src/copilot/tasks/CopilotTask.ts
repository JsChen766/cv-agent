export type CopilotTask = {
  id: string;
  type:
    | "JD_INTAKE"
    | "JD_SAVE"
    | "JD_ANALYZE"
    | "EXPERIENCE_REWRITE"
    | "RESUME_GENERATE_FROM_JD"
    | "RESUME_OPTIMIZE_ITEM"
    | "RESUME_EXPORT";
  status:
    | "planned"
    | "running"
    | "needs_input"
    | "needs_confirmation"
    | "completed"
    | "failed";
  ownerAgent:
    | "frontdesk"
    | "strategist"
    | "experience_receiver"
    | "architect"
    | "critic";
  inputRefs: {
    jdId?: string;
    jdDraftId?: string;
    experienceId?: string;
    experienceDraftId?: string;
    resumeId?: string;
    resumeItemId?: string;
    variantId?: string;
  };
  missingInputs?: string[];
  resultRefs?: {
    jdId?: string;
    generationId?: string;
    resumeId?: string;
    variantIds?: string[];
    revisionId?: string;
    exportId?: string;
  };
  createdAt: string;
  updatedAt: string;
};
