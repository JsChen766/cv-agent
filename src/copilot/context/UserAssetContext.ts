export type AssetManifestItem = {
  id: string;
  type: "experience" | "jd" | "resume" | "generation";
  title: string;
  organization?: string;
  role?: string;
  company?: string;
  targetRole?: string;
  tags?: string[];
  summary?: string;
  updatedAt?: string;
  source?: "saved" | "draft" | "active";
};

export type DraftManifestItem = {
  id: string;
  type: "jdDraft" | "experienceDraft" | "resumeDraft";
  title?: string;
  summary?: string;
  rawTextPreview?: string;
  targetRole?: string;
  company?: string;
  updatedAt?: string;
};

export type UserAssetContext = {
  experiences: AssetManifestItem[];
  jds: AssetManifestItem[];
  resumes: AssetManifestItem[];
  generations: AssetManifestItem[];
  drafts: DraftManifestItem[];

  active: {
    experienceId?: string;
    jdId?: string;
    resumeId?: string;
    variantId?: string;
    jdDraftId?: string;
    experienceDraftId?: string;
  };

  counts: {
    experiences: number;
    jds: number;
    resumes: number;
    generations: number;
    drafts: number;
  };

  retrievalPolicy: {
    mode: "manifest_only" | "manifest_plus_active_detail" | "needs_tool_lookup";
    maxItemsPerType: number;
    maxSummaryChars: number;
  };
};
