import { detectKnownSkills, tokenize } from "../keywordUtils.js";

export type EvidenceCompletenessGuardInput = {
  rawText: string;
  evidenceExcerpts: string[];
  maxEvidenceExcerpts?: number;
};

export type EvidenceCompletenessGuardResult = {
  evidenceExcerpts: string[];
  addedExcerpts: string[];
  droppedExcerpts: string[];
};

const DEFAULT_MAX_EVIDENCE_EXCERPTS = 5;

export class EvidenceCompletenessGuard {
  complete(input: EvidenceCompletenessGuardInput): EvidenceCompletenessGuardResult {
    const maxEvidenceExcerpts = input.maxEvidenceExcerpts ?? DEFAULT_MAX_EVIDENCE_EXCERPTS;
    const sourceSentences = this.splitSourceSentences(input.rawText);
    const evidenceExcerpts = this.dedupe(input.evidenceExcerpts.map((excerpt) => excerpt.trim()).filter(Boolean));
    const completed = [...evidenceExcerpts];
    const addedExcerpts: string[] = [];

    for (const sentence of sourceSentences) {
      if (this.scoreSourceSentence(sentence) < 2) {
        continue;
      }
      if (this.isCoveredByEvidence(sentence, completed)) {
        continue;
      }
      completed.push(sentence);
      addedExcerpts.push(sentence);
    }

    const ranked = completed
      .map((excerpt, index) => ({
        excerpt,
        index,
        score: this.scoreSourceSentence(excerpt),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const kept = ranked
      .slice(0, maxEvidenceExcerpts)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.excerpt);
    const keptSet = new Set(kept);

    return {
      evidenceExcerpts: kept,
      addedExcerpts: addedExcerpts.filter((excerpt) => keptSet.has(excerpt)),
      droppedExcerpts: completed.filter((excerpt) => !keptSet.has(excerpt)),
    };
  }

  private splitSourceSentences(rawText: string): string[] {
    const candidates: string[] = [];
    for (const line of rawText.split(/\r?\n/)) {
      const trimmedLine = line.replace(/^[-*]\s*/, "").trim();
      if (!trimmedLine) {
        continue;
      }
      const parts = trimmedLine.split(/([.;。；])/);
      for (let i = 0; i < parts.length; i += 2) {
        const text = `${parts[i] ?? ""}${parts[i + 1] ?? ""}`.trim();
        if (this.isUsableSentence(text)) {
          candidates.push(text);
        }
      }
    }
    return this.dedupe(candidates);
  }

  private scoreSourceSentence(sentence: string): number {
    if (!this.isUsableSentence(sentence)) {
      return 0;
    }

    let score = 0;
    if (detectKnownSkills(sentence).length > 0) score += 2;
    if (/\b(built|implemented|created|designed|optimized|integrated|launched|shipped|led|owned|developed)\b/i.test(sentence)) score += 2;
    if (/\b(reduced|improved|increased|decreased|saved|achieved|delivered|grew|lowered|raised)\b/i.test(sentence)) score += 3;
    if (/\d|%/.test(sentence)) score += 2;
    if (/\b(for|across)\s+\d+[\w\s-]*(teams|users|customers|products|projects|markets)\b|\bfor\s+(?:users|customers)\b/i.test(sentence)) score += 1;
    if (/\b(accessibility|accessible|wcag|api integration|api patterns|api|design system|component library|performance|bundle size)\b/i.test(sentence)) score += 2;
    return score;
  }

  private isCoveredByEvidence(sentence: string, evidenceExcerpts: string[]): boolean {
    return evidenceExcerpts.some((excerpt) => this.evidenceCoversSentence(sentence, excerpt));
  }

  private evidenceCoversSentence(sentence: string, evidenceExcerpt: string): boolean {
    const sentenceText = sentence.trim().toLowerCase();
    const evidenceText = evidenceExcerpt.trim().toLowerCase();
    if (!sentenceText || !evidenceText) {
      return false;
    }

    if (!this.hasRequiredNumbers(sentenceText, evidenceText)) {
      return false;
    }
    if (!this.hasRequiredCriticalTerms(sentenceText, evidenceText)) {
      return false;
    }
    if (evidenceText.includes(sentenceText) || sentenceText.includes(evidenceText)) {
      return true;
    }

    const sentenceTokens = tokenize(sentenceText);
    const evidenceTokens = new Set(tokenize(evidenceText));
    if (sentenceTokens.length === 0) {
      return false;
    }
    const overlap = sentenceTokens.filter((token) => evidenceTokens.has(token)).length / sentenceTokens.length;
    return overlap >= 0.65;
  }

  private hasRequiredNumbers(sentence: string, evidenceExcerpt: string): boolean {
    const sentenceNumbers = this.extractNumbers(sentence);
    if (sentenceNumbers.length === 0) {
      return true;
    }
    const evidenceNumbers = new Set(this.extractNumbers(evidenceExcerpt));
    return sentenceNumbers.every((number) => evidenceNumbers.has(number));
  }

  private hasRequiredCriticalTerms(sentence: string, evidenceExcerpt: string): boolean {
    const criticalGroups = [
      ["accessibility", "accessible", "wcag", "a11y"],
      ["api integration", "api patterns", "api"],
    ];

    return criticalGroups.every((group) =>
      !group.some((term) => sentence.includes(term)) ||
      group.some((term) => evidenceExcerpt.includes(term)),
    );
  }

  private extractNumbers(text: string): string[] {
    return Array.from(new Set(text.match(/\d+(?:\.\d+)?%?/g) ?? []));
  }

  private isUsableSentence(sentence: string): boolean {
    const englishWords = sentence.match(/[A-Za-z]+/g) ?? [];
    return sentence.trim().length >= 12 && englishWords.length >= 3;
  }

  private dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const key = value.trim().toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(value.trim());
    }
    return result;
  }
}
