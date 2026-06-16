/**
 * Phase 0 baseline fixture: 期望的一页中文简历结构样例
 *
 * 该 fixture 是一个**前瞻性结构示例**，用于：
 *   1. 给后续阶段（阶段 3 ResumeDocument、阶段 4 onePageModernTemplate、
 *      阶段 5/6 Fit Engine）提供一个稳定的“目标输出形态”锚点。
 *   2. 在 Phase 0 基线测试中作为软断言（key sections 是否齐全），
 *      不要求当前 generation 输出完全一致，仅作为参考标尺。
 *
 * 注意：当前 Phase 0 不引入 ResumeDocument 类型（那是阶段 3 的事），
 *       因此这里使用一个**本地、最小**的 TypeScript 结构，避免与
 *       未来 src/product/types.ts 的 ResumeDocument 提前耦合。
 *       阶段 3 完成后，可以把该 fixture 迁移为真实 ResumeDocument 实例。
 */

export type Phase0ExpectedResumeBullet = {
  /** bullet 文本（行动 + 方法 + 结果） */
  text: string;
  /** 来源经历的 fixture title（仅在测试断言中用作软关联） */
  sourceExperienceTitle?: string;
  /** 是否为不可压缩的核心 bullet */
  pinned?: boolean;
};

export type Phase0ExpectedResumeSectionItem = {
  title?: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  bullets: Phase0ExpectedResumeBullet[];
};

export type Phase0ExpectedResumeSection = {
  type: "summary" | "education" | "internship" | "project" | "skill" | "award";
  title: string;
  order: number;
  items: Phase0ExpectedResumeSectionItem[];
};

export type Phase0ExpectedResumeDocument = {
  header: {
    name: string;
    targetRole: string;
    contact: { label: string; value: string }[];
  };
  sections: Phase0ExpectedResumeSection[];
  metadata: {
    language: "zh";
    targetPages: 1;
    densityHint: "standard";
    /** 期望的最小 section 类型集合，用于断言 generation 覆盖度 */
    requiredSectionTypes: Phase0ExpectedResumeSection["type"][];
  };
};

export const PHASE0_EXPECTED_RESUME: Phase0ExpectedResumeDocument = {
  header: {
    name: "示例候选人",
    targetRole: "高级前端工程师",
    contact: [
      { label: "邮箱", value: "candidate@example.com" },
      { label: "手机", value: "138-0000-0000" },
      { label: "城市", value: "上海" },
    ],
  },
  sections: [
    {
      type: "summary",
      title: "个人简介",
      order: 1,
      items: [
        {
          bullets: [
            {
              text: "5 年前端经验，主导过协作编辑器、AI Copilot 类产品的核心模块；精通 Vue 3 + TypeScript，关注性能与工程质量。",
              pinned: true,
            },
          ],
        },
      ],
    },
    {
      type: "project",
      title: "项目经历",
      order: 2,
      items: [
        {
          title: "求职 Copilot - Resume Workspace",
          organization: "个人项目",
          role: "全栈作者 / 前端主导",
          startDate: "2024-03",
          endDate: "2025-02",
          bullets: [
            {
              text: "基于 Vue 3 + TypeScript + Pinia 构建多 Agent 简历 Copilot 工作台，自研对话与版本对比组件。",
              sourceExperienceTitle: "求职 Copilot - Resume Workspace（个人主导）",
              pinned: true,
            },
            {
              text: "落地 Playwright 驱动的 HTML → 一页 PDF 导出链路，覆盖中英文混排与字体回退。",
              sourceExperienceTitle: "求职 Copilot - Resume Workspace（个人主导）",
              pinned: true,
            },
            {
              text: "通过 Vitest + Playwright 建立端到端测试，生成→接受→导出关键链路通过率 100%。",
              sourceExperienceTitle: "求职 Copilot - Resume Workspace（个人主导）",
            },
          ],
        },
      ],
    },
    {
      type: "internship",
      title: "实习经历",
      order: 3,
      items: [
        {
          title: "字节跳动 前端开发实习生",
          organization: "字节跳动",
          role: "前端开发实习生",
          startDate: "2020-06",
          endDate: "2020-12",
          bullets: [
            {
              text: "主导“评论锚点漂移”修复项目，通过重构 OT 偏移算法将异常率从 1.8% 降到 0.2%。",
              sourceExperienceTitle: "字节跳动 前端开发实习生",
              pinned: true,
            },
            {
              text: "参与飞书文档首屏性能优化，将冷启动平均时长从 2.3s 优化到 1.4s。",
              sourceExperienceTitle: "字节跳动 前端开发实习生",
            },
          ],
        },
      ],
    },
    {
      type: "education",
      title: "教育背景",
      order: 4,
      items: [
        {
          title: "复旦大学 计算机科学与技术 本科",
          organization: "复旦大学",
          startDate: "2017-09",
          endDate: "2021-07",
          bullets: [
            {
              text: "毕业设计：基于 Vue 3 + TypeScript 的可视化算法教学平台，获评校级优秀毕业设计。",
              sourceExperienceTitle: "复旦大学 计算机科学与技术 本科",
            },
          ],
        },
      ],
    },
    {
      type: "skill",
      title: "技能",
      order: 5,
      items: [
        {
          bullets: [
            {
              text: "语言：TypeScript / JavaScript（精通）；框架：Vue 3（精通）、React（熟练）；测试：Vitest、Playwright。",
              sourceExperienceTitle: "前端核心技能栈",
              pinned: true,
            },
          ],
        },
      ],
    },
  ],
  metadata: {
    language: "zh",
    targetPages: 1,
    densityHint: "standard",
    requiredSectionTypes: ["summary", "project", "education", "skill"],
  },
};
