from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_optimizer import ResumeLayoutOptimizer
from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.domain.resume.layout_service import ResumeLayoutService
from app.infra.layout import PillowFontMetrics


class _CountingMetrics:
    def __init__(self) -> None:
        self.delegate = PillowFontMetrics()
        self.calls = 0

    @property
    def font_checksums(self) -> dict[str, str]:
        return self.delegate.font_checksums

    def text_width_mm(self, text, style) -> float:
        self.calls += 1
        return self.delegate.text_width_mm(text, style)


def _structure(*, bullet_text: str = "A" * 70, item_count: int = 1) -> dict[str, object]:
    profile = DEFAULT_RESUME_LAYOUT_PROFILE
    return {
        "language": "zh-CN",
        "layout_profile_version": profile.version,
        "layout_profile_hash": profile.profile_hash,
        "contact": {"name": "测试用户", "email": "test@example.com"},
        "sections": [
            {
                "id": "sec-experience",
                "type": "experience",
                "heading": "工作经历",
                "items": [
                    {
                        "id": f"item-{index}",
                        "title": "后端工程师",
                        "organization": "示例公司",
                        "role": "工程师",
                        "start_date": "2024-01",
                        "end_date": "2025-01",
                        "source_experience_id": f"exp-{index}",
                        "raw_text": None,
                        "bullets": [
                            {
                                "id": f"bullet-{index}-{bullet_index}",
                                "text": bullet_text,
                                "matched_jd_requirement_ids": [],
                            }
                            for bullet_index in range(8)
                        ],
                    }
                    for index in range(item_count)
                ],
            }
        ],
    }


def test_bullet_fit_uses_exact_two_thirds_gate() -> None:
    service = ResumeLayoutService(PillowFontMetrics())

    below_gate = service.measure_bullet_fit(
        "A" * 67, bullet_id="short", item_id="item", section_type="experience"
    )
    passing = service.measure_bullet_fit(
        "A" * 68, bullet_id="pass", item_id="item", section_type="experience"
    )
    awkward = service.measure_bullet_fit(
        "A" * 110, bullet_id="awkward", item_id="item", section_type="experience"
    )

    assert below_gate.last_line_ratio < below_gate.gate_ratio == 0.667
    assert below_gate.status == "too_short"
    assert passing.last_line_ratio >= passing.gate_ratio
    assert passing.status == "pass"
    assert awkward.line_count == 2
    assert awkward.status == "awkward_wrap"


def test_repeated_bullet_measurement_reuses_exact_width_and_wrap_cache() -> None:
    metrics = _CountingMetrics()
    service = ResumeLayoutService(metrics)

    first = service.measure_bullet_fit(
        "使用 **Python** 构建 API，并将 p95 延迟降低 40%",
        bullet_id="bullet-1",
        item_id="item-1",
        section_type="experience",
    )
    calls_after_first = metrics.calls
    second = service.measure_bullet_fit(
        "使用 **Python** 构建 API，并将 p95 延迟降低 40%",
        bullet_id="bullet-2",
        item_id="item-1",
        section_type="experience",
    )

    assert second.line_widths_mm == first.line_widths_mm
    assert second.last_line_ratio == first.last_line_ratio
    assert metrics.calls == calls_after_first


def test_single_line_grounded_short_exception_cannot_bypass_gate() -> None:
    service = ResumeLayoutService(PillowFontMetrics())

    result = service.measure_bullet_fit(
        "Python",
        bullet_id="short",
        item_id="item",
        section_type="experience",
        exception="unfixable_grounded_short",
    )

    assert result.line_count == 1
    assert result.status == "too_short"


def test_grounded_short_exception_cannot_bypass_multiline_gate() -> None:
    service = ResumeLayoutService(PillowFontMetrics())

    result = service.measure_bullet_fit(
        "A" * 110,
        bullet_id="awkward",
        item_id="item",
        section_type="experience",
        exception="unfixable_grounded_short",
    )

    assert result.line_count == 2
    assert result.status == "awkward_wrap"


def test_grounded_short_exception_is_reported_as_hard_width_violation() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(bullet_text="Python")
    sections = structure["sections"]
    assert isinstance(sections, list)
    sections[0]["items"][0]["bullets"][0]["layout_exception"] = "unfixable_grounded_short"

    report = service.measure_resume_layout(structure)
    violation = next(
        violation for violation in report.violations if violation.code == "bullet_too_short"
    )

    assert violation.severity == "hard"
    assert report.status == "needs_revision"


def test_terminal_periods_are_hard_layout_violations() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(bullet_text="A" * 75 + ".")
    sections = structure["sections"]
    assert isinstance(sections, list)
    sections[0]["items"][0]["raw_text"] = "GPA 3.8。"

    report = service.measure_resume_layout(structure)

    codes = {violation.code for violation in report.violations}
    assert "bullet_terminal_period" in codes
    assert "raw_text_terminal_period" in codes
    assert report.status == "needs_revision"


def test_layout_paginates_by_blocks_and_enforces_single_page() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(item_count=10)

    single_page = service.measure_resume_layout(structure, LayoutConstraint(max_pages=1))
    multi_page = service.measure_resume_layout(structure, LayoutConstraint(max_pages=None))

    assert single_page.page_count > 1
    assert single_page.overflow_mm > 0
    assert any(v.code == "page_limit_exceeded" for v in single_page.violations)
    assert multi_page.page_count == single_page.page_count
    assert multi_page.overflow_mm == 0
    assert all(page.blocks for page in multi_page.pages)


def test_single_page_requires_at_least_ninety_percent_usage() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(bullet_text="A" * 75)

    report = service.measure_resume_layout(structure, LayoutConstraint(max_pages=1))

    assert report.page_count == 1
    assert report.pages[0].usage_ratio < 0.90
    assert report.underfill_mm > 0
    assert report.status == "needs_revision"
    assert any(v.code == "page_underfilled" for v in report.violations)


def test_single_page_at_or_above_ninety_percent_has_no_underfill_violation() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(bullet_text="A" * 75, item_count=6)

    report = service.measure_resume_layout(structure, LayoutConstraint(max_pages=1))

    assert report.page_count == 1
    assert report.pages[0].usage_ratio >= 0.90
    assert report.underfill_mm == 0
    assert report.status == "pass"
    assert all(v.code != "page_underfilled" for v in report.violations)


def test_profile_mismatch_and_summary_never_pass() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure()
    structure["layout_profile_hash"] = "unknown"
    sections = structure["sections"]
    assert isinstance(sections, list)
    sections.insert(0, {"id": "summary", "type": "summary", "heading": "总结", "items": []})

    report = service.measure_resume_layout(structure)

    assert report.status == "profile_mismatch"
    assert {violation.code for violation in report.violations} >= {
        "profile_mismatch",
        "summary_forbidden",
    }


def test_optimizer_repairs_real_awkward_bullets_without_model_revision() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    profile = DEFAULT_RESUME_LAYOUT_PROFILE
    item_bullets = [
        [
            "编写95+个复杂SQL脚本（单个最高约500行），使用窗口函数与多表关联优化分析逻辑，实现用户行为与交易数据的自动化处理与准确性提升，沉淀高复用数据资产",
            "搭建并交付50+个Power BI/Datawind交互式看板，核心报表周浏览超200次，支撑业务实时决策",
            "协同产品、风控及运营团队在2周内统一20+核心指标，沉淀标准化报表框架，赋能30+业务成员自助分析",
            "构建入金、交易、留存及收入分析口径，覆盖EFTD、ARPU、DAU等核心指标，支持10+次活动复盘、渠道效果评估与高价值用户识别",
        ],
        [
            "处理30万+条语料库，采用去重、缺失值插补等方法将有效数据占比从82%提升至97%",
            "管理300万+条关键词库与语料库，设计标准化标签体系，数据检索效率提升40%以上",
            "主导撰写算法与标注规范文档10余份，助力江西省首个AI大模型备案成功；精通数据处理全流程，擅长跨团队协作与AI辅助实践",
            "领导标注团队定位并修复50+异常值与标注偏差，将标注错误率从5%降至1%以下",
        ],
        [
            "构建页面级与时间序列特征体系，提取日均编辑次数、30日留存率等关键指标",
            "基于多维特征进行用户分层与归因分析，总结高争议页面特征（高回退比、密集短间隔编辑）",
            "成功搭建分布式系统处理54.3GB数据，设计流式解析+分批处理管道，使用Scala、Apache Spark、Hadoop，产出可复用数据管道支撑后续聚类建模",
        ],
        [
            "参与设计人群流量分析模块，构建'进入-停留-离开'链路，统计不同时段人流分布",
            "设计并优化查询与统计逻辑，支持按时段、区域的多维分析，为异常预警提供数据支撑",
            "通过后端线程优化与前端重构，使页面响应时间降低约40%，操作步骤减少20%",
            "主导撰写研究报告、用户手册等累计10万余字文档，支撑项目顺利验收与团队快速上手",
            "项目成果获第十八届挑战杯三等奖，同时取得南昌大学智能监控摄像头外观专利",
        ],
    ]
    source_fact_ids = {
        f"fact-{item_index}-{bullet_index}"
        for item_index, bullets in enumerate(item_bullets)
        for bullet_index in range(len(bullets))
    }
    structure: dict[str, object] = {
        "language": "zh-CN",
        "layout_profile_version": profile.version,
        "layout_profile_hash": profile.profile_hash,
        "contact": {"name": "测试用户"},
        "sections": [
            {
                "id": "experience",
                "type": "experience",
                "heading": "工作经历",
                "items": [
                    {
                        "id": f"item-{item_index}",
                        "title": "数据分析师",
                        "source_experience_id": f"exp-{item_index}",
                        "bullets": [
                            {
                                "id": f"bullet-{item_index}-{bullet_index}",
                                "text": text,
                                "source_fact_ids": [f"fact-{item_index}-{bullet_index}"],
                                "matched_jd_requirement_ids": [f"req-{item_index}"],
                            }
                            for bullet_index, text in enumerate(bullets)
                        ],
                    }
                    for item_index, bullets in enumerate(item_bullets)
                ],
            }
        ],
    }

    result = ResumeLayoutOptimizer(service).optimize(
        structure,
        LayoutConstraint(
            max_pages=None,
            minimum_page_usage_ratio=0,
            target_page_usage_ratio=0.88,
            maximum_page_usage_ratio=1,
        ),
    )

    assert all(fit.status == "pass" for fit in result.report.bullet_fits)
    repaired_fact_ids = {
        fact_id
        for section in result.structure["sections"]
        for item in section["items"]
        for bullet in item["bullets"]
        for fact_id in bullet["source_fact_ids"]
    }
    assert repaired_fact_ids == source_fact_ids
