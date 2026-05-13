import type { Skill, SkillCategory } from "./types.js";

type KnownSkill = {
  name: string;
  category: SkillCategory;
  aliases: string[];
};

export const KNOWN_SKILLS: KnownSkill[] = [
  {
    name: "React",
    category: "technical",
    aliases: ["react"],
  },
  {
    name: "TypeScript",
    category: "technical",
    aliases: ["typescript", "ts"],
  },
  {
    name: "Performance Optimization",
    category: "technical",
    aliases: ["performance", "bundle", "lazy loading", "tree-shaking"],
  },
  {
    name: "Accessibility",
    category: "domain",
    aliases: ["accessibility", "accessible", "wcag", "a11y"],
  },
  {
    name: "Design System",
    category: "domain",
    aliases: ["design system", "component library", "components"],
  },
  {
    name: "Leadership",
    category: "soft",
    aliases: ["led", "lead", "mentored", "managed", "coordinated"],
  },
  {
    name: "Testing",
    category: "technical",
    aliases: ["testing", "vitest", "jest", "unit test", "e2e"],
  },
  {
    name: "API Integration",
    category: "technical",
    aliases: ["api", "integration", "backend"],
  },
];

const STOP_WORDS = new Set([
  "and",
  "are",
  "for",
  "from",
  "has",
  "have",
  "into",
  "that",
  "the",
  "this",
  "with",
  "you",
  "your",
  "will",
  "years",
]);

export function stableId(prefix: string, value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return `${prefix}-${hash.toString(36)}`;
}

export function skillIdFor(userId: string, skillName: string): string {
  return stableId("skill", `${userId}:${skillName.trim().toLowerCase()}`);
}

export function detectKnownSkills(text: string): Array<Omit<Skill, "id" | "userId" | "evidenceIds" | "createdAt" | "updatedAt">> {
  const normalized = text.toLowerCase();
  return KNOWN_SKILLS.filter((skill) =>
    skill.aliases.some((alias) => normalized.includes(alias)),
  ).map((skill) => ({
    name: skill.name,
    category: skill.category,
  }));
}

export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));

  return Array.from(new Set(tokens));
}

export function splitEvidenceText(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  if (lines.length > 1) {
    return lines;
  }

  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
