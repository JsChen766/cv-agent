export type FrontDeskIntent =
  | "jd.intake"
  | "jd.save"
  | "jd.analyze"
  | "resume.generate_from_jd"
  | "experience.intake"
  | "experience.save"
  | "experience.rewrite"
  | "experience.match_against_jd"
  | "asset_grounded.write"
  | "resume.optimize_item"
  | "resume.export"
  | "general.chat"
  | "clarify";

export type FrontDeskRoute =
  | "frontdesk"
  | "strategist"
  | "experience_receiver"
  | "architect"
  | "critic";

export type FrontDeskSuggestedAction =
  | "save_jd"
  | "analyze_jd"
  | "match_experiences"
  | "generate_resume"
  | "save_experience"
  | "rewrite_experience"
  | "optimize_resume_item"
  | "compose_career_text"
  | "ask_clarification";

export type FrontDeskNext =
  | "answer_directly"
  | "handoff"
  | "ask_clarification"
  | "prepare_confirmation"
  | "execute_task";

/**
 * Concrete writing flavors that the `asset_grounded.write` intent can carry
 * via `outputType`. Kept as a string-union so the wire schema stays open
 * (additive) — callers may pass `"custom"` or any other label and we never
 * break the handoff.
 */
export type AssetGroundedOutputType =
  | "self_intro"
  | "interview_answer"
  | "cover_letter"
  | "profile_summary"
  | "project_intro"
  | "application_answer"
  | "pitch"
  | "custom";

export type AssetGroundedConstraints = {
  length?: "short" | "medium" | "long";
  language?: "zh" | "en" | "auto";
  tone?: string;
  audience?: string;
  format?: "paragraph" | "bullets" | "script" | "email" | "answer";
};

export type FrontDeskHandoff = {
  id: string;
  turnId: string;
  sessionId: string;
  intent: FrontDeskIntent;
  confidence: number;
  routeTo: FrontDeskRoute;
  userGoal?: string;
  /**
   * Free-form internal goal hint (e.g. for asset_grounded.write this often
   * matches `outputType`). Optional + additive; consumers may ignore it.
   */
  goal?: string;
  /**
   * Concrete output flavor for asset-grounded writing. Optional + additive.
   * Strings outside `AssetGroundedOutputType` are tolerated; downstream
   * consumers should treat unknowns as `"custom"`.
   */
  outputType?: AssetGroundedOutputType | string;
  /** Length / language / tone / audience / format hints. Optional + additive. */
  constraints?: AssetGroundedConstraints;
  extracted: {
    jdText?: string;
    experienceText?: string;
    resumeText?: string;
    jdId?: string;
    experienceId?: string;
    /** Phase 1 additive: list-form scope for asset-grounded writing. */
    experienceIds?: string[];
    /** Phase 1 additive: natural-language keyword to be resolved later. */
    experienceQuery?: string;
    resumeId?: string;
    resumeItemId?: string;
    fileId?: string;
    resumeFileId?: string;
    originalName?: string;
    variantId?: string;
    title?: string;
    company?: string;
    targetRole?: string;
    location?: string;
    requirements?: string[];
    responsibilities?: string[];
    keywords?: string[];
  };
  missingInputs?: string[];
  suggestedActions?: FrontDeskSuggestedAction[];
  next: FrontDeskNext;
  createdAt: string;
  raw?: Record<string, unknown>;
};
