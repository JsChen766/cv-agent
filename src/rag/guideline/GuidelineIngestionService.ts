import { createHash } from "node:crypto";
import type { GuidelineRepository } from "./GuidelineRepository.js";
import type {
  ApplicationType,
  GuidelineChunk,
  GuidelineLanguage,
  GuidelineRoleFamily,
  GuidelineRuleKind,
  GuidelineSourceType,
} from "./types.js";

export type GuidelineIngestionDocument = {
  sourceId?: string;
  sourceType: GuidelineSourceType;
  title: string;
  content: string;
  language?: GuidelineLanguage;
  roleFamily?: GuidelineRoleFamily;
  industry?: string;
  applicationType?: ApplicationType;
  tags?: string[];
  ruleKind?: GuidelineRuleKind;
  mandatory?: boolean;
  metadata?: Record<string, unknown>;
};

export class GuidelineIngestionService {
  public constructor(private readonly repository: GuidelineRepository) {}

  public async ingest(documents: GuidelineIngestionDocument[]): Promise<GuidelineChunk[]> {
    const chunks = documents.flatMap((document) => toChunks(document));
    return this.repository.upsertGuidelineChunks(chunks);
  }
}

function toChunks(document: GuidelineIngestionDocument): GuidelineChunk[] {
  const sections = splitContent(document.content);
  const now = new Date().toISOString();
  return sections.map((content, index) => {
    const sourceId = document.sourceId ?? stableId(`${document.title}:${document.content}`);
    return {
      id: `guideline-${sourceId}-${index + 1}`,
      sourceType: document.sourceType,
      roleFamily: document.roleFamily,
      industry: document.industry,
      applicationType: document.applicationType,
      language: document.language ?? detectLanguage(content),
      title: sections.length > 1 ? `${document.title} · ${index + 1}` : document.title,
      content,
      tags: Array.from(new Set([...(document.tags ?? []), ...extractTags(content)])).slice(0, 30),
      metadata: {
        ...(document.metadata ?? {}),
        builtIn: false,
        mandatory: document.mandatory ?? false,
        ruleKind: document.ruleKind ?? inferRuleKind(document.sourceType),
        provenance: document.sourceId ?? document.title,
        sourceDocumentId: document.sourceId,
        chunkIndex: index,
      },
      createdAt: now,
      updatedAt: now,
    };
  });
}

function splitContent(content: string): string[] {
  const normalized = content.replace(/\r/g, "").trim();
  if (!normalized) return [];
  const sections = normalized
    .split(/\n(?=#{1,4}\s|[A-Z][A-Z\s]{3,}:|[一二三四五六七八九十]+[、.])/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 30);
  const source = sections.length > 0 ? sections : [normalized];
  return source.flatMap((section) => chunkByLength(section, 1200, 180)).slice(0, 100);
}

function chunkByLength(text: string, maxLength: number, overlap: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLength);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("。", end), text.lastIndexOf(". ", end), text.lastIndexOf("\n", end));
      if (boundary > start + Math.floor(maxLength * 0.55)) end = boundary + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

function extractTags(content: string): string[] {
  const tokens = content.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}|[\u4e00-\u9fff]{2,8}/g) ?? [];
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([token]) => token);
}

function detectLanguage(content: string): GuidelineLanguage {
  const chinese = (content.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return chinese > Math.max(4, content.length * 0.08) ? "zh" : "en";
}

function inferRuleKind(sourceType: GuidelineSourceType): GuidelineRuleKind {
  if (sourceType === "example_resume") return "example_pattern";
  if (sourceType === "role_template" || sourceType === "school_template") return "section_strategy";
  return "writing_rule";
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
