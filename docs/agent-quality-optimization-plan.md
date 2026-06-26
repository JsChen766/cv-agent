# Agent 能力质量三阶段优化计划

## 背景与目标

当前后端到前端链路已跑通，但核心 Agent 能力质量不足：JD 匹配与分析偏弱、简历生成不像专业简历、最终 PDF 内容与版式不达标。后续优化按三阶段推进：先做好 JD 匹配与分析，再提升简历内容生成，最后优化 PDF 导出格式。每个阶段必须通过真实 Docker 后端接口调用和真实 LLM 效果验收；若效果不达标，继续在当前阶段迭代，不进入下一阶段。

参考目标简历样本：`E:/Jobbb/陈剑升-香港城市大学.pdf`。阶段 2 和阶段 3 要把该文件作为内容密度、表达方式、版式层级和一页简历观感的目标基准之一。

## 全局原则

- 只改 Agent 内部能力，不改公开后端接口、请求/响应结构、ProductBlock 合约、前端消费语义。
- 不删除或弱化现有能力：RAG、自进化/Preference、critic、fit engine、generation grounding、导入解析等能力都必须保留并尽量复用。
- 优先通过现有扩展点演进：`src/agent-core/capabilities`、`src/rag`、`src/self-evolution`、`src/agent-tools`、`src/product`、`src/exports`。避免继续把复杂逻辑塞进 `AgentOrchestrator`。
- 可以引入新依赖，但必须隔离在内部 adapter/service 后面；除非能明显降低复杂度或提升可测试性，否则不引入 LangChain/LangGraph 等重型抽象。
- 每阶段都先建立可重复的真实验收脚本，再做能力优化；主观判断必须落到可保存的输入、输出、评分和问题清单。
- PowerShell 中出现中文乱码时，不直接当作业务失败；必须用 UTF-8 安全文件或脚本读取请求/响应。

## 阶段一：JD 匹配与分析能力

目标：让系统能准确拆解 JD、识别硬性/软性要求、找到候选经历中的真实证据，并给出合理分数、匹配原因、缺口和改写方向。

主要改造范围：

- `src/agent-tools/experience/matchExperiencesAgainstJD.tool.ts`
- `src/agent-core/prompts/prompts/tools/experience/jd-match-system.md`
- `src/rag/evidence/JDRequirementParser.ts`
- `src/rag/evidence/RequirementQueryPlanner.ts`
- `src/rag/evidence/EvidencePackBuilder.ts`
- 必要时新增内部 `JDAnalysisService` / `MatchCalibrationService`，但不新增公开 API。

实施要点：

- 先把 JD 拆成结构化要求：职责、硬技能、行业/业务域、资历、语言、加分项、隐性能力。
- 匹配分数拆成多维分：requirement coverage、evidence strength、transferability、recency/seniority、risk/missing info；最终分数不应因为关键词不同就整体偏低。
- 证据必须引用经历正文或结构化字段，避免“看起来匹配但无证据”。
- 输出仍保持现有 `match_experiences_against_jd` 数据形状，只在内部和 metadata 可兼容字段中增强。
- 建立高/中/低匹配校准样例，避免“所有分都很低”或“所有经历都虚高”。

验收门槛：

- 使用真实 Docker 后端 `/copilot/chat` 调用至少 3 个 JD：强匹配、部分匹配、弱匹配。
- 输出必须包含清晰 JD 拆解、top matches、证据、缺口和可执行改写建议。
- 人工严格判定：top 结果是否符合常识；高匹配是否有真实证据；低分是否能解释原因。
- 若高质量经历仍被低估，或 JD 只是粗糙摘要，则继续优化阶段一。

## 阶段一完成记录（2026-06-25）

本阶段已完成第一轮能力优化，并通过本机真实 Docker 后端和真实 LLM 调用验收。测试入口为 `http://127.0.0.1:3000/copilot/chat`，用户为 `dev-user`，先通过现有接口读取到 16 条已解析经历，再构造 3 份自然 JD 进行强匹配、部分匹配、弱匹配测试。测试脚本保存在 `scripts/phase1-jd-match-smoke.ts`，不新增公开接口。

已完成的 Agent 内部优化：

- 为 `match_experiences_against_jd` 增加结构化 JD 拆解：目标岗位、职责、硬性要求、软性要求、加分项、行业信号、排除信号。
- 扩充经历输入上下文，把 `techStack`、量化指标、highlights 和正文片段一起提供给 LLM，减少只看标题或关键词的误判。
- 升级 JD 匹配系统提示词，要求按证据、职责覆盖、领域贴合、可迁移性和缺口评分；禁止把 JD 中无证据支持的要求直接写成已匹配。
- 增加内部校准与清洗逻辑：过滤无证据技术词，限制 skill/education/award 类条目虚高，压低跨领域且只有软技能迁移的弱匹配。
- 保持现有工具名、接口路径、响应 envelope、ProductBlock 和前端消费语义不变，仅在兼容 `data` 中增加 `jdAnalysis`。

真实 LLM 验收结果：

- 强匹配 JD：金融科技数据分析/BI 分析岗位，要求 SQL、BI dashboard、交易/用户活跃/活动复盘指标。结果为 WEEX 数据分析实习经历 `0.95 high`，证据覆盖 95+ SQL、50+ dashboard、跨团队指标、交易与活跃分析；其余经历降为 medium/low，排序合理。
- 部分匹配 JD：机器学习数据工程实习，要求数据清洗、特征处理、Spark/Hadoop 或 Python、标注/质量评估。结果为 AI 数据处理经历和 Wikipedia 大规模行为数据分析位于 top high；相关 Python/传感器/数据项目进入 medium；无关条目 low。此前出现的“无证据 Python 匹配”已被清洗。
- 弱匹配 JD：奢侈品零售门店运营/品牌活动助理，明确不涉及数据工程或 AI。结果为 `0 high / 0 medium / 16 low`，最高仅 `0.44 low`，理由集中在软技能可迁移但缺少零售、客户服务、陈列和门店运营证据。

严格判断：阶段一达到进入下一阶段的最低质量要求，满意度约 90% 以上。当前匹配已能区分强/中/弱场景，top 结果符合常识，低匹配不会被关键词或泛化软技能抬高。剩余可改进点是 JD 拆解仍为内部轻量 parser，后续若需要更细粒度行业 rubric，可继续扩展为独立 `JDAnalysisService`，但不阻塞阶段二。

## 阶段二：简历内容生成能力

目标：生成的简历内容要像专业候选人简历，而不是松散段落；必须针对 JD，有证据支撑，有清晰定位，并接近参考 PDF 的表达质量。

主要改造范围：

- `src/agent-tools/resume/generateResumeFromJD.tool.ts`
- `src/product/services/index.ts` 中 `GenerationProductService`
- `src/product/LLMGenerationService.ts`
- `src/agent-core/prompts/prompts/product/generation-resume-system.md`
- `src/exports/ResumeQualityService.ts`
- `src/exports/ResumeQualityCriticService.ts`
- RAG guideline / evidence / preference pack 的生成输入装配。

实施要点：

- 生成前必须消费阶段一的匹配结果或等价 evidence pack，而不是只把 JD 和经历丢给 LLM。
- 生成结构化 `resumeDocument`，优先输出一页简历所需的 summary、skills、experience/project、education，并保留 legacy content fallback。
- 引入“目标简历风格 rubric”：信息密度、动词质量、量化表达、JD 对齐、证据完整性、重复度、中文/英文一致性、风险声明。
- 让 critic 从“阻塞/泛评”转为可执行质量反馈：指出哪条 bullet 弱、为什么弱、如何改。
- 严禁编造公司、项目、指标；没有证据时要保守表达或列为 missing info。

验收门槛：

- 真实 Docker 后端完成 JD 匹配、生成、确认保存变体的完整链路。
- 至少比较 2 轮输出：改造前 baseline 与改造后结果。
- 人工严格判定：简历是否有明确定位；每条 bullet 是否像可投递简历；是否有无证据夸大；整体是否接近参考 PDF 的专业度。
- 若只是“能生成”但不像好简历，不进入阶段三。

## 阶段二完成记录（2026-06-26）

本阶段已完成第一轮简历内容生成能力优化，并通过本机真实 Docker 后端与真实 LLM 调用验收。测试使用 `scripts/phase2-resume-generation-smoke.ts`，链路覆盖 `/copilot/chat`、`/copilot/actions`、`/copilot/pending-actions/:id/confirm`、`/jobs/:id`、`/product/generations/:id`、`/product/resumes/:id`，用户为 `dev-user`。详细报告保存在 `docs/agent-quality-phase2-resume-generation-report-2026-06-26.md`。

基线问题：

- 简历正文偏短，像松散总结，不像可投递的一页简历。
- 部分结果出现“某公司/某大学”等占位式编造，且存在日期、机构细节不稳的问题。
- RAG 已在链路中使用，但 generation 输入缺少足够权威的候选人 source cards，导致模型有时根据 JD 猜事实。
- 生成内容没有稳定形成结构化简历条目，后续保存和 PDF 阶段可用性不足。

已完成的 Agent 内部优化：

- 升级 `generation-resume-system.md`，要求参考样例简历的信息密度、量化 bullet、真实学校/公司/日期、JD 偏向改写和无占位词输出。
- 在 `LLMGenerationService` 中加入候选人 source cards，把经历标题、机构、角色、日期、分类、标签、结构化字段和正文摘要作为权威事实传给 LLM。
- 调整 `GenerationProductService` 的素材选择：在 RAG 相关经历之外，固定带入教育、技能、奖项等基础素材，避免生成时缺少简历骨架。
- 增加中文 RAG guideline，强化“动作 + 方法/技术 + 范围 + 量化结果”的简历表达标准。
- 为内部 `resumeDocument` 增加 fallback 解析，使确认保存后的简历能拆成 education、skill、experience、project、award 等 item。
- 改进 evidence sentence split，减少小数、日期、单位被切碎后造成的无效 unsupported claim。

真实 LLM 验收结果：

- `data_bi` 金融科技数据分析/BI JD：最终生成 `pgen-66867406-c9a1-478a-b94b-508275a74c0d`，正文约 710 字，7 条 bullet，9 个量化指标，0 个占位词；保存为 `pres-df6500a3-d222-485c-8dc0-99f0e1c987ae`，落成 7 个结构化 resume items。内容聚焦 WEEX SQL、Datawind/BI 看板、核心指标口径、交易/活跃/留存分析和 Wikipedia 大规模数据项目，符合 JD 偏向。
- `ml_data` 机器学习数据工程 JD：最终生成 `pgen-9376c7c8-0420-41a0-a69f-d2267a3843b7`，正文约 929 字，10 条 bullet，14 个量化指标，0 个占位词；保存为 `pres-a3aa1f2a-4edb-43d4-afd6-77a51b358114`，落成 11 个结构化 resume items。内容突出语料清洗、标注质量、关键词库管理、Spark/Hadoop 大数据处理、传感器/流量数据项目和技术奖项。
- `ai_product` AI 产品数据分析 JD：最终生成 `pgen-6235f59b-d3cf-4db2-ad49-47b44bb39af8`，正文约 908 字，11 条 bullet，22 个量化指标，0 个占位词；保存为 `pres-94655adf-0d96-4222-b6ac-18a3f9b4735a`，落成 7 个结构化 resume items。内容把 WEEX 数据分析、新华云 AI 文档/数据治理和 3D 艾灸项目要求分析组合成偏产品数据方向的履历。

严格判断：阶段二达到进入阶段三的最低质量要求，满意度约 90%。最终结果已经明显接近参考简历的内容密度和量化表达，能根据不同 JD 做偏向性组织，未再出现明显占位编造。剩余问题主要是 `riskSummary` 对部分真实改写句仍偏保守，以及 PDF 版式/一页压缩尚未优化；这些不阻塞阶段三，但阶段三需要继续利用结构化 resume items 做最终成品质量控制。

## 阶段三：PDF 导出格式与最终成品

目标：导出的 PDF 在内容与版式上都像可投递的一页简历，默认模板质量接近参考 PDF，不再只是“把文本塞进 PDF”。

主要改造范围：

- `src/exports/templates/onePageModernTemplate.ts`
- `src/exports/ResumeHtmlRenderer.ts`
- `src/exports/ResumeExportService.ts`
- `src/exports/ResumeFitService.ts`
- `src/exports/ResumeCompressionService.ts`
- `src/exports/ResumeLLMFitEditor.ts`
- `src/exports/ResumeQualityService.ts`

实施要点：

- 先从参考 PDF 提炼版式原则：页边距、姓名/联系信息、section 顺序、标题层级、项目 bullet 密度、技能展示方式。
- 保持 `one-page-modern` 作为默认高质量路径；如需新增模板，只新增内部模板 ID，不改变导出 API。
- PDF 不只检查 `%PDF`，还要检查页面数量、文本可复制性、关键 section 存在、溢出/留白、标题与 bullet 层级。
- fit/compression/LLM fit editor 必须服务于可读性，不能为了塞进一页牺牲内容质量。

验收门槛：

- 真实 Docker 后端完成生成、接受版本、导出 PDF、下载文件。
- 对导出 PDF 做机器检查：content-type、PDF header、页数、文本提取、关键 section。
- 做人工严格判断：是否像参考 PDF 一样可投递；是否存在拥挤、断行、缺 section、内容重复、格式廉价感。
- 若 PDF 只是技术上可下载但观感不达标，继续阶段三。

## 真实 LLM 验收记录要求

每次阶段验收都应保存一份报告到 `docs/`，建议命名为：

- `docs/agent-quality-phase1-jd-match-report-YYYY-MM-DD.md`
- `docs/agent-quality-phase2-resume-generation-report-YYYY-MM-DD.md`
- `docs/agent-quality-phase3-pdf-export-report-YYYY-MM-DD.md`

报告至少包含：测试日期、Docker/env 摘要（不含密钥）、输入 JD、是否使用参考简历样本、接口调用路径、关键响应摘要、质量评分、失败点、下一轮修改计划、是否允许进入下一阶段。

## 推荐执行顺序

1. 建立阶段一真实 LLM smoke 脚本，固定 3 个 JD 和已解析经历库。
2. 跑 baseline，记录当前问题，不先改 prompt。
3. 优化 JD 拆解、证据召回、评分校准和匹配解释。
4. 阶段一通过后，再让生成链路显式消费高质量匹配证据。
5. 阶段二通过后，再处理 PDF 模板和 fit pipeline。
6. 每阶段结束都运行 `npm run typecheck`、相关 Vitest、真实 Docker 调用，并保存验收报告。
