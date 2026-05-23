export type JDProfile = {
  jdId?: string;
  jdDraftId?: string;
  targetRole?: string;
  company?: string;
  title?: string;
  responsibilities: string[];
  hardRequirements: string[];
  softRequirements: string[];
  preferredExperiences: string[];
  keywords: string[];
  seniority?: string;
  riskNotes?: string[];
};
