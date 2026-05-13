import type { JDRequirement } from "../../knowledge/types.js";

export type ExtractJDRequirementsInput = {
  userId: string;
  jdText: string;
  targetRole: string;
};

export type ExtractJDRequirementsResult = {
  jdId: string;
  requirements: JDRequirement[];
};

export interface JDRequirementExtractor {
  extract(input: ExtractJDRequirementsInput): Promise<ExtractJDRequirementsResult>;
}
