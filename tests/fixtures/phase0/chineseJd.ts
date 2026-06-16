/**
 * Phase 0 baseline fixture: 中文 JD（高级前端工程师）
 *
 * 用于跨阶段（agent / 工具 / 生成 / 导出）回归测试，确保后续重构在
 * 真实中文场景下仍可走通：保存 JD → 匹配经历 → 生成简历 → 接受 → 导出。
 *
 * 该 fixture 不依赖任何运行时模块，只导出纯数据，方便在 vitest、
 * 集成脚本或调试脚本中复用。
 */

export type Phase0JDFixture = {
  /** 简短标题，用于产品库 ProductJDRecord.title */
  title: string;
  /** 公司名（可选） */
  company: string;
  /** 目标岗位，会用于 generateResumeFromJD 的 targetRole */
  targetRole: string;
  /** 完整 JD 原文（rawText） */
  rawText: string;
  /** 高优先级关键词，用于断言匹配/生成结果中的命中度 */
  mustHaveKeywords: string[];
  /** 加分项关键词 */
  niceToHaveKeywords: string[];
};

export const PHASE0_CHINESE_JD: Phase0JDFixture = {
  title: "高级前端工程师 - 求职 Copilot 平台",
  company: "示例科技（上海）有限公司",
  targetRole: "高级前端工程师",
  rawText: [
    "岗位名称：高级前端工程师（求职 Copilot 平台）",
    "工作地点：上海 / 远程混合",
    "汇报对象：前端技术负责人",
    "",
    "岗位职责：",
    "1. 负责求职 Copilot Web 端核心模块的设计与开发，包括对话工作台、简历编辑器、",
    "   导出与版本对比等关键体验。",
    "2. 与产品经理、设计师、后端工程师协作，把多 Agent 流式输出、PDF 导出、",
    "   富文本编辑等复杂交互打磨到生产可用。",
    "3. 持续优化前端性能：包括首屏渲染、长会话内存占用、弱网下的容错降级。",
    "4. 建设组件库与设计系统，沉淀可复用的业务组件，提升团队交付效率。",
    "5. 参与代码评审、单元测试与端到端测试建设，保障核心链路稳定。",
    "",
    "岗位要求：",
    "1. 5 年以上前端开发经验，精通 TypeScript、Vue 3 或 React 之一，并对另一",
    "   框架的核心理念有较深理解。",
    "2. 熟悉 Vite / Webpack、ESM 模块系统、CSS 工程化与现代浏览器渲染原理。",
    "3. 有大型 SaaS / 协作类产品交付经验，能独立 owning 复杂业务模块。",
    "4. 熟悉 Web 性能优化：能定位长任务、内存泄漏、白屏问题，给出可量化的优化结果。",
    "5. 良好的工程素养：单元测试、E2E 测试、CI/CD、可观测性等有实践经验。",
    "",
    "加分项：",
    "- 有 LLM 应用 / Copilot 类产品前端落地经验。",
    "- 有富文本 / 文档编辑器（ProseMirror、Tiptap、Monaco 等）开发经验。",
    "- 有简历、文档导出（HTML → PDF、Playwright、Puppeteer）相关经验。",
    "- 有开源贡献或技术博客。",
    "",
    "我们期望候选人：",
    "- 关注用户体验，能从工程化角度推动产品质量提升。",
    "- 有清晰的沟通能力，能与多角色协同推进复杂项目。",
  ].join("\n"),
  mustHaveKeywords: [
    "TypeScript",
    "Vue 3",
    "性能优化",
    "组件库",
    "测试",
  ],
  niceToHaveKeywords: [
    "LLM",
    "Copilot",
    "PDF",
    "Playwright",
    "ProseMirror",
  ],
};
