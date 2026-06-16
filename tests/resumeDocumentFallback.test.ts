import { describe, expect, it } from "vitest";
import { buildResumeDocumentFromContent } from "../src/product/resumeDocumentFallback.js";
import type { ResumeDocument } from "../src/product/types.js";

describe("buildResumeDocumentFromContent", () => {
  it("returns undefined for empty/whitespace content", () => {
    expect(buildResumeDocumentFromContent("")).toBeUndefined();
    expect(buildResumeDocumentFromContent("   \n\n   ")).toBeUndefined();
  });

  it("wraps unstructured content in a single experience section + item with bullet lines", () => {
    const doc = buildResumeDocumentFromContent("Worked on payments.\nShipped checkout v2.")!;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].type).toBe("experience");
    expect(doc.sections[0].items).toHaveLength(1);
    expect(doc.sections[0].items[0].bullets.length).toBeGreaterThanOrEqual(1);
  });

  it("infers section type from common Chinese keywords", () => {
    const doc = buildResumeDocumentFromContent([
      "# 教育背景",
      "清华大学 - 计算机科学",
      "",
      "# 项目经历",
      "支付系统重构",
      "- 主导后端架构升级",
      "",
      "# 技能",
      "TypeScript / Go / Postgres",
    ].join("\n"))!;
    const types = doc.sections.map((s) => s.type);
    expect(types).toContain("education");
    expect(types).toContain("project");
    expect(types).toContain("skill");
  });

  it("splits items by blank lines within a section and parses bullet lines", () => {
    const doc = buildResumeDocumentFromContent([
      "# 工作经历",
      "高级前端工程师 - 字节跳动",
      "- 主导团队规模扩张",
      "- 推动 SSR 上线",
      "",
      "前端工程师 - 美团",
      "- 重构组件库",
    ].join("\n"))!;
    const exp = doc.sections.find((s) => s.type === "experience")!;
    expect(exp.items).toHaveLength(2);
    expect(exp.items[0].bullets.length).toBe(2);
    expect(exp.items[1].bullets.length).toBe(1);
    // Bullet text strips bullet prefix.
    expect(exp.items[0].bullets[0].text).toBe("主导团队规模扩张");
  });

  it("produces unique non-empty ids for sections, items, and bullets", () => {
    const doc = buildResumeDocumentFromContent([
      "# 工作经历",
      "工程师 A",
      "- 做了 A",
      "",
      "工程师 B",
      "- 做了 B",
    ].join("\n"))!;
    const ids: string[] = [];
    for (const section of doc.sections) {
      ids.push(section.id);
      for (const item of section.items) {
        ids.push(item.id);
        for (const bullet of item.bullets) ids.push(bullet.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("matches the ResumeDocument shape exposed by types.ts (compile-time)", () => {
    const doc: ResumeDocument | undefined = buildResumeDocumentFromContent("# Experience\n- Did things");
    expect(doc?.schemaVersion).toBe(1);
  });
});
