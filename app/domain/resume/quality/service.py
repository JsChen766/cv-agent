from __future__ import annotations

import hashlib
import re
from collections import Counter
from typing import Any, Literal

from app.domain.resume.candidates.models import CandidateBullet
from app.domain.resume.compiler.models import CompiledResume
from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.quality.models import (
    GroundingReport,
    QualityIssue,
    QualityValidationReport,
    RequirementCoverageReport,
)
from app.domain.resume.retrieval.models import HybridRetrievalResult

_NUMBER = re.compile(r"(?<!\w)\d+(?:[.,]\d+)?%?")
_SPACE = re.compile(r"\s+")
_COMMON_TECHNOLOGIES = {
    "airflow",
    "android",
    "angular",
    "aws",
    "azure",
    "c++",
    "clickhouse",
    "docker",
    "elasticsearch",
    "fastapi",
    "flask",
    "gcp",
    "git",
    "golang",
    "graphql",
    "hadoop",
    "java",
    "javascript",
    "kafka",
    "kotlin",
    "kubernetes",
    "langchain",
    "langgraph",
    "linux",
    "mongodb",
    "mysql",
    "next.js",
    "node.js",
    "openai",
    "pandas",
    "postgresql",
    "power bi",
    "pytorch",
    "react",
    "redis",
    "rust",
    "scala",
    "scikit-learn",
    "spark",
    "sql",
    "sqlite",
    "supabase",
    "swift",
    "tensorflow",
    "typescript",
    "vue",
}
_TECH_ALIASES = {
    "js": "javascript",
    "nodejs": "node.js",
    "node": "node.js",
    "postgres": "postgresql",
    "powerbi": "power bi",
    "sklearn": "scikit-learn",
    "ts": "typescript",
}
_BULLET_REPAIRABLE_CODES = {
    "bullet_awkward_wrap",
    "bullet_duplicate_text",
    "bullet_number_mismatch",
    "bullet_technology_mismatch",
    "bullet_terminal_period",
    "bullet_too_short",
    "bullet_very_short",
}
_FATAL_LAYOUT_CODES = {
    "font_checksum_mismatch",
    "forced_block_split",
    "page_limit_exceeded",
    "profile_mismatch",
}


class ResumeQualityGateService:
    """Deterministic final gate for the V2 compiled resume."""

    validation_version = "resume-quality-gate-v2"

    def validate(
        self,
        plan: ResumePlan,
        retrieval: HybridRetrievalResult,
        candidates: tuple[CandidateBullet, ...],
        compiled: CompiledResume,
        constraint: LayoutConstraint,
        *,
        must_have_threshold: float = 0.80,
        max_repair_bullets: int = 3,
    ) -> QualityValidationReport:
        issues: list[QualityIssue] = []
        fact_by_id = {value.fact_id: value for value in retrieval.facts}
        experience_by_id = {value.experience_id: value for value in retrieval.experiences}
        candidate_by_id = {value.bullet_id: value for value in candidates}
        if compiled.plan_version != plan.plan_version:
            issues.append(
                QualityIssue(
                    code="compiled_plan_version_mismatch",
                    message="Compiled resume was produced from a different ResumePlan version.",
                    scope="global",
                )
            )
        selected_candidates: list[CandidateBullet] = []
        invalid_candidate_ids: list[str] = []
        for candidate_id in compiled.selected_candidate_ids:
            candidate = candidate_by_id.get(candidate_id)
            if candidate is None:
                invalid_candidate_ids.append(candidate_id)
            else:
                selected_candidates.append(candidate)
        if invalid_candidate_ids:
            issues.append(
                QualityIssue(
                    code="selected_candidate_missing",
                    message="Compiled resume references candidates absent from the candidate pool.",
                    scope="global",
                )
            )

        structure_bullets, duplicate_bullet_ids = _structure_bullets(compiled.structured_resume)
        if duplicate_bullet_ids:
            issues.append(
                QualityIssue(
                    code="duplicate_bullet_id",
                    message="The compiled structure contains duplicate bullet IDs.",
                    scope="global",
                )
            )
        selected_ids = {value.bullet_id for value in selected_candidates}
        if set(structure_bullets) != selected_ids:
            issues.append(
                QualityIssue(
                    code="compiled_structure_candidate_mismatch",
                    message="Compiled structure bullets do not match selected candidate IDs.",
                    scope="global",
                )
            )

        fact_counts: Counter[str] = Counter()
        invalid_fact_ids: set[str] = set()
        mismatched_fact_ids: set[str] = set()
        stale_revision_fact_ids: set[str] = set()
        grounded_bullets = 0
        covered_requirement_ids: set[str] = set()
        normalized_texts: dict[str, str] = {}
        technology_vocabulary = _technology_vocabulary(plan, retrieval)
        fit_by_id = {value.bullet_id: value for value in compiled.layout_report.bullet_fits}

        for candidate in selected_candidates:
            raw_bullet = structure_bullets.get(candidate.bullet_id)
            if raw_bullet is None:
                continue
            structure_fact_ids = tuple(
                str(value) for value in raw_bullet.get("source_fact_ids") or [] if value
            )
            structure_requirement_ids = tuple(
                str(value) for value in raw_bullet.get("matched_jd_requirement_ids") or [] if value
            )
            structure_text = str(raw_bullet.get("text") or "").strip()
            if (
                structure_text != candidate.text.strip()
                or structure_fact_ids != candidate.source_fact_ids
                or structure_requirement_ids != candidate.covered_requirement_ids
            ):
                issues.append(
                    QualityIssue(
                        code="candidate_structure_payload_mismatch",
                        message="Compiled bullet content or evidence metadata changed after selection.",
                        scope="bullet",
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                    )
                )

            fact_ids = tuple(dict.fromkeys(candidate.source_fact_ids))
            if len(fact_ids) != len(candidate.source_fact_ids):
                issues.append(
                    QualityIssue(
                        code="duplicate_source_fact_within_bullet",
                        message="A bullet repeats the same source fact ID.",
                        scope="bullet",
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=candidate.source_fact_ids,
                    )
                )
            facts = [fact_by_id.get(value) for value in fact_ids]
            missing = {
                fact_id for fact_id, fact in zip(fact_ids, facts, strict=True) if fact is None
            }
            unplanned = set(fact_ids) - set(plan.selected_fact_ids)
            wrong_experience = {
                fact_id
                for fact_id, fact in zip(fact_ids, facts, strict=True)
                if fact is not None and fact.experience_id != candidate.experience_id
            }
            source_experience = experience_by_id.get(candidate.experience_id)
            stale_revision = {
                fact_id
                for fact_id, fact in zip(fact_ids, facts, strict=True)
                if fact is not None
                and source_experience is not None
                and fact.source_revision_id != source_experience.revision_id
            }
            invalid_fact_ids.update(missing | unplanned)
            mismatched_fact_ids.update(wrong_experience)
            stale_revision_fact_ids.update(stale_revision)
            if not fact_ids or missing or unplanned or wrong_experience or stale_revision:
                issues.append(
                    QualityIssue(
                        code="bullet_grounding_invalid",
                        message="Bullet source facts are missing or belong to another experience.",
                        scope="bullet",
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                    )
                )
                continue

            grounded_bullets += 1
            fact_counts.update(fact_ids)
            grounded_facts = [value for value in facts if value is not None]
            source_text = "\n".join(value.source_text for value in grounded_facts)
            allowed_numbers = set(_NUMBER.findall(source_text))
            drafted_numbers = set(_NUMBER.findall(candidate.text))
            unsupported_numbers = sorted(drafted_numbers - allowed_numbers)
            if unsupported_numbers:
                issues.append(
                    QualityIssue(
                        code="bullet_number_mismatch",
                        message=(
                            "Bullet contains numbers absent from its cited facts: "
                            + ", ".join(unsupported_numbers)
                        ),
                        scope="bullet",
                        repairable=True,
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                    )
                )
            unsupported_technologies = _unsupported_technologies(
                candidate.text,
                source_text,
                tuple(technology for fact in grounded_facts for technology in fact.technologies),
                technology_vocabulary,
            )
            if unsupported_technologies:
                issues.append(
                    QualityIssue(
                        code="bullet_technology_mismatch",
                        message=(
                            "Bullet contains technologies absent from its cited facts: "
                            + ", ".join(unsupported_technologies)
                        ),
                        scope="bullet",
                        repairable=True,
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                    )
                )

            allowed_requirements = {
                requirement_id
                for fact_id in fact_ids
                for requirement_id in plan.fact_requirement_map.get(fact_id, ())
            }
            declared_requirements = set(candidate.covered_requirement_ids)
            invalid_requirements = declared_requirements - allowed_requirements
            if invalid_requirements:
                issues.append(
                    QualityIssue(
                        code="bullet_requirement_not_grounded",
                        message="Bullet claims requirement coverage unsupported by its facts.",
                        scope="bullet",
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                        requirement_ids=tuple(sorted(invalid_requirements)),
                    )
                )
            covered_requirement_ids.update(declared_requirements & allowed_requirements)

            normalized = _normalize_text(candidate.text)
            duplicate_of = normalized_texts.get(normalized)
            if duplicate_of is not None:
                issues.append(
                    QualityIssue(
                        code="bullet_duplicate_text",
                        message=f"Bullet duplicates the text of {duplicate_of}.",
                        scope="bullet",
                        repairable=True,
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                    )
                )
            elif normalized:
                normalized_texts[normalized] = candidate.bullet_id
            if len(normalized) < 8:
                issues.append(
                    QualityIssue(
                        code="bullet_very_short",
                        message="Bullet is too short to be readable.",
                        scope="bullet",
                        repairable=True,
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                    )
                )
            fit = fit_by_id.get(candidate.bullet_id)
            if fit is None:
                issues.append(
                    QualityIssue(
                        code="bullet_measurement_missing",
                        message="Selected bullet has no final layout measurement.",
                        scope="bullet",
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                    )
                )
            elif fit.status != "pass":
                issues.append(
                    QualityIssue(
                        code=f"bullet_{fit.status}",
                        message="Bullet tail or wrapping does not satisfy the layout contract.",
                        scope="bullet",
                        repairable=True,
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                    )
                )
            if candidate.text.rstrip().endswith((".", "。")):
                issues.append(
                    QualityIssue(
                        code="bullet_terminal_period",
                        message="Narrative bullet ends with a sentence period.",
                        scope="bullet",
                        repairable=True,
                        bullet_id=candidate.bullet_id,
                        experience_id=candidate.experience_id,
                        fact_ids=fact_ids,
                    )
                )

        duplicate_fact_ids = tuple(
            sorted(value for value, count in fact_counts.items() if count > 1)
        )
        if duplicate_fact_ids:
            issues.append(
                QualityIssue(
                    code="duplicate_source_fact",
                    message="The same source fact is used by more than one final bullet.",
                    scope="global",
                    fact_ids=duplicate_fact_ids,
                )
            )
        if set(compiled.selected_fact_ids) != set(fact_counts):
            issues.append(
                QualityIssue(
                    code="compiled_selected_fact_mismatch",
                    message="Compiled selected facts do not match audited final bullet facts.",
                    scope="global",
                )
            )

        issues.extend(_metadata_issues(compiled.structured_resume, experience_by_id))
        coverage = _coverage_report(
            plan,
            covered_requirement_ids,
            threshold=must_have_threshold,
        )
        if coverage.must_have_coverage_ratio + 1e-9 < must_have_threshold:
            issues.append(
                QualityIssue(
                    code="must_have_coverage_below_threshold",
                    message=(
                        f"Evidence-backed must-have coverage is "
                        f"{coverage.must_have_coverage_ratio:.1%}; required {must_have_threshold:.0%}."
                    ),
                    scope="global",
                    requirement_ids=coverage.uncovered_must_have_requirement_ids,
                )
            )

        report = compiled.layout_report
        usage = report.pages[0].usage_ratio if report.pages else 0.0
        if report.page_count != 1:
            issues.append(
                QualityIssue(
                    code="page_count_invalid",
                    message="Compiled resume must occupy exactly one page.",
                    scope="global",
                )
            )
        if report.overflow_mm > 1e-6 or any(value.overflow_mm > 1e-6 for value in report.pages):
            issues.append(
                QualityIssue(
                    code="layout_overflow",
                    message="Compiled resume overflows the printable page.",
                    scope="global",
                )
            )
        if not constraint.minimum_page_usage_ratio <= usage <= constraint.maximum_page_usage_ratio:
            issues.append(
                QualityIssue(
                    code="layout_usage_out_of_band",
                    message="Compiled page usage is outside the required 85%-98% band.",
                    scope="global",
                )
            )
        for violation in report.violations:
            if violation.code in _FATAL_LAYOUT_CODES:
                issues.append(
                    QualityIssue(
                        code=violation.code,
                        message=violation.message,
                        scope="global",
                    )
                )
        if usage < constraint.minimum_page_usage_ratio:
            unused_facts = set(plan.selected_fact_ids) - set(compiled.selected_fact_ids)
            if unused_facts:
                issues.append(
                    QualityIssue(
                        code="underfilled_with_unused_high_value_facts",
                        message="Page is underfilled while planned grounded facts remain unused.",
                        scope="global",
                        fact_ids=tuple(sorted(unused_facts)),
                    )
                )
        if _has_orphan_section(compiled.structured_resume):
            issues.append(
                QualityIssue(
                    code="orphan_section_heading",
                    message="A rendered section heading has no content item.",
                    scope="global",
                )
            )

        issues = _dedupe_issues(issues)
        repairable_ids = tuple(
            sorted(
                {
                    issue.bullet_id
                    for issue in issues
                    if issue.repairable
                    and issue.code in _BULLET_REPAIRABLE_CODES
                    and issue.bullet_id is not None
                }
            )
        )
        all_repairable = bool(issues) and all(
            issue.repairable
            and issue.code in _BULLET_REPAIRABLE_CODES
            and issue.bullet_id is not None
            for issue in issues
        )
        status: Literal["passed", "repairable", "failed"]
        if not issues:
            status = "passed"
        elif all_repairable and len(repairable_ids) <= max_repair_bullets:
            status = "repairable"
        else:
            status = "failed"
        grounding = GroundingReport(
            selected_bullets=len(selected_candidates),
            grounded_bullets=grounded_bullets,
            ungrounded_bullets=max(0, len(selected_candidates) - grounded_bullets),
            selected_facts=len(fact_counts),
            duplicate_fact_ids=duplicate_fact_ids,
            invalid_fact_ids=tuple(sorted(invalid_fact_ids)),
            mismatched_experience_fact_ids=tuple(sorted(mismatched_fact_ids)),
            stale_revision_fact_ids=tuple(sorted(stale_revision_fact_ids)),
        )
        return QualityValidationReport(
            validation_version=self.validation_version,
            status=status,
            issues=tuple(issues),
            grounding=grounding,
            coverage=coverage,
            page_usage_ratio=round(usage, 4),
            page_count=report.page_count,
            overflow_mm=report.overflow_mm,
            selected_candidate_ids=compiled.selected_candidate_ids,
            repairable_bullet_ids=repairable_ids if status == "repairable" else (),
        )


def _structure_bullets(
    structure: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], tuple[str, ...]]:
    result: dict[str, dict[str, Any]] = {}
    duplicate_ids: set[str] = set()
    for section in structure.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            for bullet in item.get("bullets") or []:
                if not isinstance(bullet, dict) or not bullet.get("id"):
                    continue
                bullet_id = str(bullet["id"])
                if bullet_id in result:
                    duplicate_ids.add(bullet_id)
                result[bullet_id] = bullet
    return result, tuple(sorted(duplicate_ids))


def _metadata_issues(
    structure: dict[str, Any],
    experience_by_id: dict[str, Any],
) -> list[QualityIssue]:
    issues: list[QualityIssue] = []
    field_map = {
        "title": "title",
        "organization": "organization",
        "role": "role",
        "start_date": "start_date",
        "end_date": "end_date",
    }
    for section in structure.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            experience_id = str(item.get("source_experience_id") or "")
            if not experience_id:
                # Contact/profile-derived skills and other fixed blocks are not
                # FactBank experience items and are audited by their own source path.
                continue
            source = experience_by_id.get(experience_id)
            if source is None:
                issues.append(
                    QualityIssue(
                        code="unknown_source_experience",
                        message="Structured item references an unknown source experience.",
                        scope="item",
                        experience_id=experience_id or None,
                    )
                )
                continue
            for field, source_field in field_map.items():
                drafted = _metadata_value(item.get(field))
                sourced = _metadata_value(getattr(source, source_field))
                if not _metadata_matches(field, drafted, sourced):
                    issues.append(
                        QualityIssue(
                            code=f"metadata_{field}_mismatch",
                            message=f"Item {field} differs from the source experience.",
                            scope="item",
                            experience_id=experience_id,
                        )
                    )
    return issues


def _coverage_report(
    plan: ResumePlan,
    covered_requirement_ids: set[str],
    *,
    threshold: float,
) -> RequirementCoverageReport:
    must_have = [value for value in plan.requirements if value.importance == "must_have"]
    total = sum(value.weight for value in must_have)
    covered = sum(
        value.weight for value in must_have if value.requirement_id in covered_requirement_ids
    )
    ratio = covered / total if total > 0 else 1.0
    return RequirementCoverageReport(
        must_have_total_weight=total,
        must_have_covered_weight=covered,
        must_have_coverage_ratio=ratio,
        threshold=threshold,
        covered_requirement_ids=tuple(sorted(covered_requirement_ids)),
        uncovered_must_have_requirement_ids=tuple(
            value.requirement_id
            for value in must_have
            if value.requirement_id not in covered_requirement_ids
        ),
    )


def _technology_vocabulary(
    plan: ResumePlan,
    retrieval: HybridRetrievalResult,
) -> tuple[str, ...]:
    values = set(_COMMON_TECHNOLOGIES)
    values.update(
        _canonical_technology(value)
        for fact in retrieval.facts
        for value in fact.technologies
        if value.strip()
    )
    for requirement in plan.requirements:
        if requirement.category.lower() in {"technology", "skill", "technical_skill"}:
            values.update(
                _canonical_technology(value) for value in requirement.keywords if value.strip()
            )
    return tuple(
        sorted(
            (value for value in values if value),
            key=lambda value: (-len(value), value),
        )
    )


def _unsupported_technologies(
    text: str,
    source_text: str,
    explicit_technologies: tuple[str, ...],
    vocabulary: tuple[str, ...],
) -> tuple[str, ...]:
    normalized_text = _normalize_technology_text(text)
    normalized_source = _normalize_technology_text(source_text)
    allowed = {_canonical_technology(value) for value in explicit_technologies}
    detected = {
        technology for technology in vocabulary if _contains_technology(normalized_text, technology)
    }
    supported = {
        technology
        for technology in detected
        if technology in allowed or _contains_technology(normalized_source, technology)
    }
    return tuple(sorted(detected - supported))


def _contains_technology(text: str, technology: str) -> bool:
    escaped = re.escape(technology)
    return re.search(rf"(?<![a-z0-9+#.]){escaped}(?![a-z0-9+#.])", text) is not None


def _canonical_technology(value: str) -> str:
    normalized = _normalize_technology_text(value).strip(" .")
    return _TECH_ALIASES.get(normalized, normalized)


def _normalize_technology_text(value: str) -> str:
    return _SPACE.sub(" ", value.casefold().replace("／", "/")).strip()


def _normalize_text(value: str) -> str:
    return "".join(value.casefold().split()).rstrip("。.！!")


def _metadata_value(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return str(value.isoformat())
    return str(value).strip()


def _metadata_matches(field: str, drafted: str, sourced: str) -> bool:
    if field not in {"start_date", "end_date"}:
        return drafted == sourced
    drafted_normalized = drafted.casefold().strip()
    sourced_normalized = sourced.casefold().strip()
    if (
        field == "end_date"
        and not sourced_normalized
        and drafted_normalized in {"current", "present", "至今", "现在"}
    ):
        return True
    if re.fullmatch(r"\d{4}-\d{2}(?:-\d{2})?", drafted_normalized) and re.fullmatch(
        r"\d{4}-\d{2}(?:-\d{2})?", sourced_normalized
    ):
        return drafted_normalized[:7] == sourced_normalized[:7]
    return drafted_normalized == sourced_normalized


def _has_orphan_section(structure: dict[str, Any]) -> bool:
    for section in structure.get("sections") or []:
        if not isinstance(section, dict) or not section.get("heading"):
            continue
        items = [value for value in section.get("items") or [] if isinstance(value, dict)]
        if not items:
            return True
    return False


def _dedupe_issues(issues: list[QualityIssue]) -> list[QualityIssue]:
    result: list[QualityIssue] = []
    seen: set[str] = set()
    for issue in issues:
        key = hashlib.sha256(
            repr(
                (
                    issue.code,
                    issue.scope,
                    issue.bullet_id,
                    issue.experience_id,
                    issue.fact_ids,
                    issue.requirement_ids,
                )
            ).encode("utf-8")
        ).hexdigest()
        if key not in seen:
            seen.add(key)
            result.append(issue)
    return result
