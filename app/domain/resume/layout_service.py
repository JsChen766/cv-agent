"""Deterministic A4 resume measurement and pagination rules."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from app.domain.resume.layout_models import (
    BlockLayoutReport,
    BulletFitReport,
    LayoutConstraint,
    LayoutReport,
    LayoutStatus,
    LayoutViolation,
    PageReport,
    SectionLayoutReport,
)
from app.domain.resume.layout_ports import TextMetricsPort
from app.domain.resume.layout_profile import (
    DEFAULT_RESUME_LAYOUT_PROFILE,
    ResumeLayoutProfile,
    TextStyle,
)

_INLINE_TOKEN = re.compile(r"(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]*\))")
_CJK = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff]")
_BREAK_AFTER = set(" \t-–—/，。；：！？、,.!?;:)]}）】》」』")
_NO_LINE_START = set("，。；：！？、,.!?;:)]}）】》」』%％")
_NO_LINE_END = set("([{（【《「『")


@dataclass(frozen=True)
class _MeasuredBlock:
    block_id: str
    block_type: str
    height_mm: float
    section_id: str | None = None
    item_id: str | None = None


class ResumeLayoutService:
    def __init__(
        self,
        metrics: TextMetricsPort,
        profile: ResumeLayoutProfile = DEFAULT_RESUME_LAYOUT_PROFILE,
    ) -> None:
        self.metrics = metrics
        self.profile = profile

    def measure_bullet_fit(
        self,
        text: str,
        *,
        bullet_id: str,
        item_id: str,
        section_type: str,
        exception: str | None = None,
        language: str = "zh-CN",
    ) -> BulletFitReport:
        body_style = self._style_for_language(self.profile.body, language)
        available = (
            self.profile.content_width_mm
            - self.profile.bullet.indent_mm
            - self.profile.bullet.marker_width_mm
            - self.profile.bullet.gap_mm
        )
        lines = self._wrap_inline_text(text, available, body_style)
        widths = [self._inline_width(line, body_style) for line in lines] or [0.0]
        last_ratio = widths[-1] / available if available else 0.0
        status: Literal["pass", "too_short", "awkward_wrap", "unfixable_grounded_short"]
        recommendation: Literal["shorten", "expand_from_source", "rephrase", "remove", "none"]
        if last_ratio >= self.profile.bullet.gate_ratio:
            status, recommendation = "pass", "none"
        elif exception == "unfixable_grounded_short" and len(lines) == 1:
            status, recommendation = "unfixable_grounded_short", "none"
        elif len(lines) == 1:
            status, recommendation = "too_short", "expand_from_source"
        else:
            status, recommendation = "awkward_wrap", "rephrase"
        return BulletFitReport(
            bullet_id=bullet_id,
            section_type=section_type,
            item_id=item_id,
            line_count=len(lines),
            line_widths_mm=[round(value, 3) for value in widths],
            last_line_width_mm=round(widths[-1], 3),
            last_line_ratio=round(last_ratio, 4),
            target_ratio=self.profile.bullet.target_ratio,
            gate_ratio=self.profile.bullet.gate_ratio,
            status=status,
            recommendation=recommendation,
        )

    def measure_resume_layout(
        self,
        structured: dict[str, object],
        constraint: LayoutConstraint | None = None,
    ) -> LayoutReport:
        constraint = constraint or LayoutConstraint()
        violations: list[LayoutViolation] = []
        language = str(structured.get("language") or "zh-CN")
        active_font = self.profile.font_for_language(language)
        provided_version = structured.get("layout_profile_version")
        provided_hash = structured.get("layout_profile_hash")
        if provided_version != self.profile.version or provided_hash != self.profile.profile_hash:
            violations.append(
                LayoutViolation(
                    code="profile_mismatch",
                    message="Resume structure does not match the active layout profile.",
                )
            )
        actual_font_checksum = self.metrics.font_checksums.get(active_font.family)
        if actual_font_checksum != active_font.checksum_sha256:
            violations.append(
                LayoutViolation(
                    code="font_checksum_mismatch",
                    message=(
                        f"Text metrics font checksum for {active_font.family} does not match "
                        "the layout profile."
                    ),
                )
            )

        raw_sections = structured.get("sections")
        sections = raw_sections if isinstance(raw_sections, list) else []
        if any(
            isinstance(section, dict) and section.get("type") == "summary" for section in sections
        ):
            violations.append(
                LayoutViolation(
                    code="summary_forbidden", message="Summary sections are not rendered."
                )
            )

        blocks: list[_MeasuredBlock] = []
        bullet_fits: list[BulletFitReport] = []
        header = self._measure_header(structured.get("contact"), language)
        if header.height_mm:
            blocks.append(header)

        section_meta: dict[str, tuple[str, list[str]]] = {}
        for section_index, raw_section in enumerate(sections):
            if not isinstance(raw_section, dict) or raw_section.get("type") == "summary":
                continue
            section_id = str(raw_section.get("id") or f"section-{section_index}")
            section_type = str(raw_section.get("type") or "other")
            heading = str(raw_section.get("heading") or "")
            heading_height = (
                self.profile.spacing.section_before_mm
                + self._text_height(
                    heading,
                    self.profile.content_width_mm,
                    self._style_for_language(self.profile.section_heading, language),
                )
                + self.profile.spacing.heading_border_mm
                + self.profile.spacing.section_after_mm
            )
            blocks.append(
                _MeasuredBlock(
                    block_id=f"{section_id}:heading",
                    block_type="section_heading",
                    height_mm=heading_height,
                    section_id=section_id,
                )
            )
            item_ids: list[str] = []
            raw_items = raw_section.get("items")
            items = raw_items if isinstance(raw_items, list) else []
            for item_index, raw_item in enumerate(items):
                if not isinstance(raw_item, dict):
                    continue
                item_id = str(raw_item.get("id") or f"{section_id}:item-{item_index}")
                item_ids.append(item_id)
                item_height, item_bullets = self._measure_item(
                    raw_item,
                    item_id,
                    section_type,
                    language,
                )
                bullet_fits.extend(item_bullets)
                blocks.append(
                    _MeasuredBlock(
                        block_id=item_id,
                        block_type="item",
                        height_mm=item_height,
                        section_id=section_id,
                        item_id=item_id,
                    )
                )
            section_meta[section_id] = (section_type, item_ids)

        for fit in bullet_fits:
            if fit.status in {"too_short", "awkward_wrap"}:
                violations.append(
                    LayoutViolation(
                        code=f"bullet_{fit.status}",
                        message=(
                            f"Bullet {fit.bullet_id} last line uses "
                            f"{fit.last_line_ratio:.1%} of the available width."
                        ),
                        section_id=None,
                        item_id=fit.item_id,
                        bullet_id=fit.bullet_id,
                    )
                )
            elif fit.status == "unfixable_grounded_short":
                violations.append(
                    LayoutViolation(
                        code="unfixable_grounded_short",
                        message=f"Bullet {fit.bullet_id} is a grounded short-line exception.",
                        severity="soft",
                        item_id=fit.item_id,
                        bullet_id=fit.bullet_id,
                    )
                )

        pages, forced = self._paginate(blocks)
        overflow = 0.0
        if constraint.max_pages is not None and len(pages) > constraint.max_pages:
            overflow = sum(page.used_height_mm for page in pages[constraint.max_pages :])
            violations.append(
                LayoutViolation(
                    code="page_limit_exceeded",
                    message=f"Resume requires {len(pages)} pages; limit is {constraint.max_pages}.",
                )
            )
        underfill = 0.0
        if constraint.is_single_page and len(pages) == 1:
            page = pages[0]
            minimum_used_height = page.available_height_mm * constraint.minimum_page_usage_ratio
            if page.used_height_mm < minimum_used_height:
                underfill = minimum_used_height - page.used_height_mm
                violations.append(
                    LayoutViolation(
                        code="page_underfilled",
                        message=(
                            f"Resume uses {page.usage_ratio:.1%} of the printable A4 height; "
                            f"minimum is {constraint.minimum_page_usage_ratio:.0%}. "
                            f"Add approximately {underfill:.1f} mm of grounded content."
                        ),
                    )
                )
        for block_id in forced:
            violations.append(
                LayoutViolation(
                    code="forced_block_split",
                    message=f"Block {block_id} is taller than one printable page.",
                )
            )

        section_reports = self._section_reports(section_meta, pages)
        hard_codes = {violation.code for violation in violations if violation.severity == "hard"}
        if "profile_mismatch" in hard_codes or "font_checksum_mismatch" in hard_codes:
            status: LayoutStatus = "profile_mismatch"
        elif hard_codes:
            status = "needs_revision"
        else:
            status = "pass"
        return LayoutReport(
            profile_version=self.profile.version,
            profile_hash=self.profile.profile_hash,
            content_width_mm=self.profile.content_width_mm,
            page_available_height_mm=self.profile.content_height_mm,
            page_count=len(pages),
            overflow_mm=round(overflow, 3),
            minimum_page_usage_ratio=constraint.minimum_page_usage_ratio,
            underfill_mm=round(underfill, 3),
            pages=pages,
            sections=section_reports,
            bullet_fits=bullet_fits,
            violations=violations,
            forced_break_block_ids=forced,
            status=status,
        )

    def _measure_header(self, raw_contact: object, language: str) -> _MeasuredBlock:
        if not isinstance(raw_contact, dict):
            return _MeasuredBlock("header", "header", 0.0)
        name = str(raw_contact.get("name") or "")
        contacts = [
            str(raw_contact.get(key))
            for key in ("phone", "email", "location", "linkedin")
            if raw_contact.get(key)
        ]
        name_style = self._style_for_language(self.profile.name, language)
        contact_style = self._style_for_language(self.profile.contact, language)
        height = (
            self._text_height(name, self.profile.content_width_mm, name_style)
            if name
            else 0.0
        )
        if contacts:
            height += self._text_height(
                " · ".join(contacts), self.profile.content_width_mm, contact_style
            )
        if height:
            height += self.profile.spacing.header_after_mm
        return _MeasuredBlock("header", "header", height)

    def _measure_item(
        self,
        item: dict[str, object],
        item_id: str,
        section_type: str,
        language: str,
    ) -> tuple[float, list[BulletFitReport]]:
        item_heading_style = self._style_for_language(self.profile.item_heading, language)
        item_subheading_style = self._style_for_language(self.profile.item_subheading, language)
        date_style = self._style_for_language(self.profile.date, language)
        body_style = self._style_for_language(self.profile.body, language)
        primary = " · ".join(
            str(item.get(key)) for key in ("title", "organization") if item.get(key)
        )
        date = " – ".join(str(item.get(key)) for key in ("start_date", "end_date") if item.get(key))
        primary_width = max(
            1.0, self.profile.content_width_mm - self._inline_width(date, date_style) - 3.0
        )
        height = max(
            self._text_height(primary, primary_width, item_heading_style),
            self._text_height(date, self.profile.content_width_mm, date_style),
        )
        role = str(item.get("role") or "")
        location = str(item.get("location") or "")
        if role or location:
            secondary_width = max(
                1.0,
                self.profile.content_width_mm
                - self._inline_width(location, date_style)
                - 3.0,
            )
            height += max(
                self._text_height(role, secondary_width, item_subheading_style),
                self._text_height(location, self.profile.content_width_mm, date_style),
            )
        raw_text = item.get("raw_text")
        if isinstance(raw_text, str) and raw_text.strip():
            height += self.profile.spacing.raw_text_before_mm
            height += self._text_height(raw_text, self.profile.content_width_mm, body_style)

        reports: list[BulletFitReport] = []
        raw_bullets = item.get("bullets")
        bullets = raw_bullets if isinstance(raw_bullets, list) else []
        for bullet_index, raw_bullet in enumerate(bullets):
            if not isinstance(raw_bullet, dict):
                continue
            bullet_id = str(raw_bullet.get("id") or f"{item_id}:bullet-{bullet_index}")
            report = self.measure_bullet_fit(
                str(raw_bullet.get("text") or ""),
                bullet_id=bullet_id,
                item_id=item_id,
                section_type=section_type,
                exception=(
                    str(raw_bullet.get("layout_exception"))
                    if raw_bullet.get("layout_exception")
                    else None
                ),
                language=language,
            )
            reports.append(report)
            height += self.profile.spacing.bullet_before_mm
            height += report.line_count * body_style.line_height_mm
            height += self.profile.spacing.bullet_after_mm
        height += self.profile.spacing.item_after_mm
        return height, reports

    def _paginate(self, blocks: list[_MeasuredBlock]) -> tuple[list[PageReport], list[str]]:
        available = self.profile.content_height_mm
        pages: list[PageReport] = []
        forced: list[str] = []
        current_blocks: list[BlockLayoutReport] = []
        used = 0.0

        def finish_page() -> None:
            nonlocal current_blocks, used
            if not current_blocks and pages:
                return
            page_number = len(pages) + 1
            pages.append(
                PageReport(
                    page_number=page_number,
                    available_height_mm=available,
                    used_height_mm=round(used, 3),
                    usage_ratio=round(used / available if available else 0.0, 4),
                    overflow_mm=round(max(0.0, used - available), 3),
                    blocks=current_blocks,
                )
            )
            current_blocks = []
            used = 0.0

        index = 0
        while index < len(blocks):
            block = blocks[index]
            required = block.height_mm
            if (
                block.block_type == "section_heading"
                and self.profile.pagination.keep_section_heading_with_first_item
                and index + 1 < len(blocks)
                and blocks[index + 1].section_id == block.section_id
            ):
                required += blocks[index + 1].height_mm
            if used and used + required > available:
                finish_page()
            start = used
            used += block.height_mm
            forced_break = block.height_mm > available
            if forced_break:
                forced.append(block.block_id)
            current_blocks.append(
                BlockLayoutReport(
                    block_id=block.block_id,
                    block_type=block.block_type,
                    page_number=len(pages) + 1,
                    start_y_mm=round(start, 3),
                    end_y_mm=round(used, 3),
                    height_mm=round(block.height_mm, 3),
                    forced_break=forced_break,
                )
            )
            index += 1
        if current_blocks or not pages:
            finish_page()
        return pages, forced

    def _section_reports(
        self,
        section_meta: dict[str, tuple[str, list[str]]],
        pages: list[PageReport],
    ) -> list[SectionLayoutReport]:
        locations = {
            block.block_id: (page.page_number, block.height_mm, block.forced_break)
            for page in pages
            for block in page.blocks
        }
        reports: list[SectionLayoutReport] = []
        for section_id, (section_type, item_ids) in section_meta.items():
            ids = [f"{section_id}:heading", *item_ids]
            present = [(block_id, locations[block_id]) for block_id in ids if block_id in locations]
            if not present:
                continue
            reports.append(
                SectionLayoutReport(
                    section_id=section_id,
                    section_type=section_type,
                    start_page=min(value[0] for _, value in present),
                    end_page=max(value[0] for _, value in present),
                    height_mm=round(sum(value[1] for _, value in present), 3),
                    forced_item_break_ids=[
                        block_id for block_id, value in present if value[2] and block_id in item_ids
                    ],
                )
            )
        return reports

    def _text_height(self, text: str, width_mm: float, style: TextStyle) -> float:
        if not text:
            return 0.0
        return len(self._wrap_inline_text(text, width_mm, style)) * style.line_height_mm

    def _inline_width(self, text: str, base_style: TextStyle) -> float:
        width = 0.0
        for chunk, weight, italic in self._inline_segments(text):
            style = base_style.model_copy(
                update={
                    "font_weight": max(base_style.font_weight, weight),
                    "italic": base_style.italic or italic,
                }
            )
            width += self.metrics.text_width_mm(chunk, style)
        return width

    def _wrap_inline_text(self, text: str, width_mm: float, style: TextStyle) -> list[str]:
        lines: list[str] = []
        for paragraph in text.replace("\r\n", "\n").split("\n"):
            if not paragraph:
                lines.append("")
                continue
            start = 0
            while start < len(paragraph):
                end = start + 1
                last_break: int | None = None
                while end <= len(paragraph):
                    candidate = paragraph[start:end]
                    if self._inline_width(candidate, style) > width_mm:
                        break
                    if self._is_break_opportunity(paragraph, end):
                        last_break = end
                    end += 1
                if end > len(paragraph):
                    chosen = len(paragraph)
                else:
                    chosen = (
                        last_break if last_break and last_break > start else max(start + 1, end - 1)
                    )
                while chosen > start + 1 and paragraph[chosen - 1] in _NO_LINE_END:
                    chosen -= 1
                while chosen < len(paragraph) and paragraph[chosen] in _NO_LINE_START:
                    if self._inline_width(paragraph[start : chosen + 1], style) <= width_mm:
                        chosen += 1
                    else:
                        break
                line = paragraph[start:chosen].strip()
                lines.append(line)
                start = chosen
                while start < len(paragraph) and paragraph[start].isspace():
                    start += 1
        return lines or [""]

    @staticmethod
    def _is_break_opportunity(text: str, end: int) -> bool:
        previous = text[end - 1]
        following = text[end] if end < len(text) else ""
        return (
            end == len(text)
            or previous in _BREAK_AFTER
            or bool(_CJK.match(previous))
            or bool(following and _CJK.match(following))
        )

    @staticmethod
    def _inline_segments(text: str) -> list[tuple[str, int, bool]]:
        segments: list[tuple[str, int, bool]] = []
        cursor = 0
        for match in _INLINE_TOKEN.finditer(text):
            if match.start() > cursor:
                segments.append((text[cursor : match.start()], 400, False))
            token = match.group(0)
            if token.startswith(("**", "__")):
                segments.append((token[2:-2], 700, False))
            elif token.startswith("["):
                segments.append((token[1 : token.index("]")], 400, False))
            else:
                segments.append((token[1:-1], 400, True))
            cursor = match.end()
        if cursor < len(text):
            segments.append((text[cursor:], 400, False))
        return segments or [(text, 400, False)]

    def _style_for_language(self, style: TextStyle, language: str) -> TextStyle:
        font = self.profile.font_for_language(language)
        return style.model_copy(update={"font_family": font.family})
