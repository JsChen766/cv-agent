/**
 * Phase 0 baseline fixture: 中文经历库样本
 *
 * 覆盖 4 种 category：教育、实习、项目、技能（skill）。
 * 用于回归测试中“保存经历 → JD 匹配 → 生成简历”全链路。
 *
 * 字段口径与 src/product/types.ts 中 ProductExperienceCategory 保持一致：
 *   "work" | "internship" | "project" | "education" | "award" | "skill" | "other"
 */

import type { ProductExperienceCategory } from "../../../src/product/types.js";

export type Phase0ExperienceFixture = {
  category: ProductExperienceCategory;
  title: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  /** 经历正文（中文行动 + 方法 + 结果） */
  content: string;
  /** 主要技能/关键词标签，可参与 JD 匹配 */
  tags?: string[];
};

export const PHASE0_CHINESE_EXPERIENCES: Phase0ExperienceFixture[] = [
  {
    category: "education",
    title: "复旦大学 计算机科学与技术 本科",
    organization: "复旦大学",
    role: "本科生",
    startDate: "2017-09",
    endDate: "2021-07",
    content: [
      "主修课程：数据结构、操作系统、计算机网络、数据库系统、人机交互。",
      "毕业设计：基于 Vue 3 + TypeScript 的可视化算法教学平台，获评校级优秀毕业设计。",
      "在校期间获国家奖学金 1 次、校级一等奖学金 2 次。",
    ].join("\n"),
    tags: ["计算机科学", "Vue 3", "TypeScript", "可视化"],
  },
  {
    category: "internship",
    title: "字节跳动 前端开发实习生",
    organization: "字节跳动",
    role: "前端开发实习生",
    startDate: "2020-06",
    endDate: "2020-12",
    content: [
      "在飞书文档团队负责协作编辑器周边能力，使用 TypeScript + React。",
      "主导“评论锚点漂移”修复项目：通过重构 OT 偏移算法，将异常率从 1.8% 降低到 0.2%。",
      "参与首屏性能优化：将文档冷启动平均时长从 2.3s 优化到 1.4s（覆盖 1000+ 真实样本）。",
      "推动 Storybook 组件文档化，沉淀 12 个高复用组件，被 3 个兄弟业务线复用。",
    ].join("\n"),
    tags: ["TypeScript", "React", "性能优化", "协作编辑器", "Storybook"],
  },
  {
    category: "project",
    title: "求职 Copilot - Resume Workspace（个人主导）",
    organization: "个人项目",
    role: "全栈作者 / 前端主导",
    startDate: "2024-03",
    endDate: "2025-02",
    content: [
      "面向求职者的 AI 简历 Copilot，多 Agent 协作生成、对比、修订简历。",
      "前端基于 Vue 3 + TypeScript + Pinia + Vite 构建，自研对话工作台与版本对比组件。",
      "实现 Playwright 驱动的 HTML → 一页 PDF 导出链路，覆盖中英文混排与字体回退。",
      "通过 Vitest + Playwright 建立端到端测试，关键链路（生成→接受→导出）通过率 100%。",
      "上线 3 个月内被 200+ 求职者使用，平均节省简历准备时间约 4 小时/人。",
    ].join("\n"),
    tags: ["Vue 3", "TypeScript", "Pinia", "Playwright", "PDF", "LLM", "Copilot"],
  },
  {
    category: "skill",
    title: "前端核心技能栈",
    role: "技能盘点",
    content: [
      "语言：TypeScript（精通）、JavaScript（精通）、HTML / CSS（熟练）。",
      "框架：Vue 3（精通，含 Composition API、SSR）、React（熟练）。",
      "工程化：Vite、Webpack、ESLint、Prettier、Monorepo（pnpm workspace）。",
      "测试：Vitest、Playwright、Vue Test Utils。",
      "可观测性：Sentry、Web Vitals、自研性能埋点。",
      "其他：Node.js、Fastify、PostgreSQL（基础）。",
    ].join("\n"),
    tags: ["TypeScript", "Vue 3", "React", "Vite", "Vitest", "Playwright"],
  },
];
