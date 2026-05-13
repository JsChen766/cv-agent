import type { ExperienceType } from "../../types.js";
import { splitEvidenceText } from "../../keywordUtils.js";
import type { IngestExperienceInput } from "../ExperienceIngestionService.js";
import type { ExperienceExtractor, ExtractedExperience } from "./types.js";

export class DeterministicExperienceExtractor implements ExperienceExtractor {
  async extract(input: IngestExperienceInput): Promise<ExtractedExperience> {
    const evidenceExcerpts = splitEvidenceText(input.rawText).slice(0, 5);
    const firstExcerpt = evidenceExcerpts[0] ?? input.rawText.trim();

    return {
      type: this.detectType(input.rawText),
      organization: this.detectOrganization(input.rawText),
      role: this.detectRole(input.rawText),
      summary: firstExcerpt,
      evidenceExcerpts: evidenceExcerpts.length > 0 ? evidenceExcerpts : [input.rawText.trim()],
    };
  }

  private detectType(text: string): ExperienceType {
    const normalized = text.toLowerCase();
    if (normalized.includes("university") || normalized.includes("course")) {
      return "education";
    }
    if (normalized.includes("project") || normalized.includes("built")) {
      return "project";
    }
    return "work";
  }

  private detectOrganization(text: string): string {
    const atMatch = text.match(/\bat\s+([A-Z][A-Za-z0-9&.\-\s]{1,40})/);
    return atMatch?.[1]?.trim().replace(/[.,;:]$/, "") ?? "Unknown Organization";
  }

  private detectRole(text: string): string {
    const roleMatch = text.match(/\bas\s+(?:a|an)?\s*([A-Za-z][A-Za-z0-9&.\-\s]{1,40})\s+at\b/i);
    if (roleMatch?.[1]) {
      return roleMatch[1].trim();
    }
    if (/\b(frontend|react|typescript|component)\b/i.test(text)) {
      return "Frontend Engineer";
    }
    return "Contributor";
  }
}
