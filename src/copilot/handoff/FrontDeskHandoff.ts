export type FrontDeskIntent =
  | "jd.intake"
  | "jd.save"
  | "jd.analyze"
  | "resume.generate_from_jd"
  | "experience.intake"
  | "experience.save"
  | "experience.rewrite"
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
  | "ask_clarification";

export type FrontDeskNext =
  | "answer_directly"
  | "handoff"
  | "ask_clarification"
  | "prepare_confirmation"
  | "execute_task";

export type FrontDeskHandoff = {
  id: string;
  turnId: string;
  sessionId: string;
  intent: FrontDeskIntent;
  confidence: number;
  routeTo: FrontDeskRoute;
  userGoal?: string;
  extracted: {
    jdText?: string;
    experienceText?: string;
    resumeText?: string;
    jdId?: string;
    experienceId?: string;
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
