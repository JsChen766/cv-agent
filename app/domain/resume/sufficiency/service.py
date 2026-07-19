from __future__ import annotations

import math
import unicodedata
from collections import defaultdict

from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.retrieval.models import (
    HybridRetrievalResult,
    RankedFact,
    RetrievalExperience,
)
from app.domain.resume.sufficiency.models import (
    FactHeightEstimate,
    FixedHeightBreakdown,
    MaterialSufficiencyReport,
)

SUFFICIENCY_VERSION = "full-factbank-height-v1"


class MaterialSufficiencyService:
    """Estimate the maximum faithful resume height supported by the full FactBank."""

    def __init__(
        self,
        layout: ResumeLayoutService,
        *,
        minimum_fact_score: float = 0.15,
        minimum_fact_strength: float = 0.25,
        maximum_fact_lines: int = 3,
    ) -> None:
        self._layout = layout
        self._minimum_fact_score = minimum_fact_score
        self._minimum_fact_strength = minimum_fact_strength
        self._maximum_fact_lines = maximum_fact_lines

    def assess(
        self,
        retrieval: HybridRetrievalResult,
        *,
        user_profile: dict[str, object] | None,
        minimum_usage_ratio: float,
        language: str = "zh-CN",
    ) -> MaterialSufficiencyReport:
        experience_by_id = {value.experience_id: value for value in retrieval.experiences}
        estimates = self._estimate_facts(retrieval, experience_by_id, language)
        qualified_ids = {value.fact_id for value in estimates if value.qualified}
        qualified_facts = [value for value in retrieval.facts if value.fact_id in qualified_ids]
        narrative_experience_ids = {
            value.experience_id
            for value in qualified_facts
            if (experience_by_id.get(value.experience_id) is not None)
            and experience_by_id[value.experience_id].category != "education"
        }

        contact_structure = _supported_structure(
            retrieval.experiences,
            [],
            user_profile=user_profile,
            language=language,
            include_contact=True,
            include_education=False,
            include_skills=False,
            narrative_experience_ids=set(),
            profile_version=self._layout.profile.version,
            profile_hash=self._layout.profile.profile_hash,
        )
        education_structure = _supported_structure(
            retrieval.experiences,
            [],
            user_profile=None,
            language=language,
            include_contact=False,
            include_education=True,
            include_skills=False,
            narrative_experience_ids=set(),
            profile_version=self._layout.profile.version,
            profile_hash=self._layout.profile.profile_hash,
        )
        skills_structure = _supported_structure(
            retrieval.experiences,
            qualified_facts,
            user_profile=None,
            language=language,
            include_contact=False,
            include_education=False,
            include_skills=True,
            narrative_experience_ids=set(),
            profile_version=self._layout.profile.version,
            profile_hash=self._layout.profile.profile_hash,
        )
        fixed_structure = _supported_structure(
            retrieval.experiences,
            qualified_facts,
            user_profile=user_profile,
            language=language,
            include_contact=True,
            include_education=True,
            include_skills=True,
            narrative_experience_ids=set(),
            profile_version=self._layout.profile.version,
            profile_hash=self._layout.profile.profile_hash,
        )
        overhead_structure = _supported_structure(
            retrieval.experiences,
            qualified_facts,
            user_profile=user_profile,
            language=language,
            include_contact=True,
            include_education=True,
            include_skills=True,
            narrative_experience_ids=narrative_experience_ids,
            profile_version=self._layout.profile.version,
            profile_hash=self._layout.profile.profile_hash,
        )

        contact_height = self._measure_height(contact_structure)
        education_height = self._measure_height(education_structure)
        skills_height = self._measure_height(skills_structure)
        fixed_height = self._measure_height(fixed_structure)
        overhead_height = self._measure_height(overhead_structure)
        narrative_overhead = max(0.0, overhead_height - fixed_height)
        fact_height = sum(value.estimated_height_mm for value in estimates if value.qualified)
        supported_height = fixed_height + narrative_overhead + fact_height
        available_height = self._layout.profile.content_height_mm
        minimum_required = available_height * minimum_usage_ratio
        missing_height = max(0.0, minimum_required - supported_height)
        approximate_missing_lines = math.ceil(
            missing_height / self._layout.profile.body.line_height_mm
        )

        covered_requirement_ids = {
            requirement_id
            for value in estimates
            if value.qualified
            for requirement_id in value.matched_requirement_ids
        }
        uncovered_must_have = tuple(
            value.requirement_id
            for value in retrieval.requirements
            if value.importance == "must_have"
            and value.requirement_id not in covered_requirement_ids
        )
        warnings: list[str] = []
        if not retrieval.experiences:
            warnings.append("retrieval_experiences_missing")
        if retrieval.facts and not qualified_ids:
            warnings.append("no_qualified_facts")
        if any(
            "deterministic_revision_fallback" in value.degradation_sources
            for value in qualified_facts
        ):
            warnings.append("deterministic_factbank_fallback_used")

        return MaterialSufficiencyReport(
            status="sufficient" if missing_height <= 1e-6 else "insufficient",
            sufficiency_version=SUFFICIENCY_VERSION,
            profile_version=self._layout.profile.version,
            profile_hash=self._layout.profile.profile_hash,
            page_available_height_mm=round(available_height, 3),
            minimum_usage_ratio=minimum_usage_ratio,
            minimum_required_height_mm=round(minimum_required, 3),
            fixed_height=FixedHeightBreakdown(
                contact_height_mm=round(contact_height, 3),
                education_height_mm=round(education_height, 3),
                skills_height_mm=round(skills_height, 3),
                total_height_mm=round(fixed_height, 3),
            ),
            narrative_overhead_height_mm=round(narrative_overhead, 3),
            qualified_fact_height_mm=round(fact_height, 3),
            global_supported_height_mm=round(supported_height, 3),
            supported_usage_ratio=round(supported_height / available_height, 4),
            missing_height_mm=round(missing_height, 3),
            approximate_missing_lines=max(0, approximate_missing_lines),
            total_experiences=len(retrieval.experiences),
            total_facts=len(retrieval.facts),
            qualified_facts=len(qualified_ids),
            excluded_facts=len(retrieval.facts) - len(qualified_ids),
            covered_requirement_ids=tuple(sorted(covered_requirement_ids)),
            uncovered_must_have_requirement_ids=uncovered_must_have,
            fact_estimates=tuple(estimates),
            warnings=tuple(warnings),
        )

    def _estimate_facts(
        self,
        retrieval: HybridRetrievalResult,
        experience_by_id: dict[str, RetrievalExperience],
        language: str,
    ) -> list[FactHeightEstimate]:
        estimates: list[FactHeightEstimate] = []
        seen_source_texts: set[str] = set()
        relevance_unavailable = (
            "semantic_similarity_all_zero" in retrieval.diagnostics.warnings
            and ("lexical_technology_match_all_zero" in retrieval.diagnostics.warnings)
        )
        for fact in retrieval.facts:
            experience = experience_by_id.get(fact.experience_id)
            exclusion_reasons: list[str] = []
            qualification_reasons: list[str] = []
            normalized = _normalize_source(fact.source_text)
            if experience is None:
                exclusion_reasons.append("experience_metadata_missing")
            elif experience.category == "education":
                exclusion_reasons.append("education_counted_as_fixed_content")
            if not normalized:
                exclusion_reasons.append("empty_source_text")
            elif normalized in seen_source_texts:
                exclusion_reasons.append("duplicate_source_fact")

            if fact.matched_requirement_ids:
                qualification_reasons.append("matches_requirement")
            if fact.score.weighted_total >= self._minimum_fact_score:
                qualification_reasons.append("meets_relevance_threshold")
            if relevance_unavailable and (
                fact.score.evidence_strength >= self._minimum_fact_strength
            ):
                qualification_reasons.append("evidence_strength_fallback")
            if not qualification_reasons:
                exclusion_reasons.append("below_qualification_threshold")

            qualified = not exclusion_reasons
            estimated_lines = 0
            estimated_height = 0.0
            if qualified:
                seen_source_texts.add(normalized)
                fit = self._layout.measure_bullet_fit(
                    fact.source_text,
                    bullet_id=fact.fact_id,
                    item_id=fact.experience_id,
                    section_type=(experience.category if experience is not None else "other"),
                    language=language,
                )
                estimated_lines = max(1, min(fit.line_count, self._maximum_fact_lines))
                estimated_height = (
                    self._layout.profile.spacing.bullet_before_mm
                    + estimated_lines * self._layout.profile.body.line_height_mm
                    + self._layout.profile.spacing.bullet_after_mm
                )
            estimates.append(
                FactHeightEstimate(
                    fact_id=fact.fact_id,
                    experience_id=fact.experience_id,
                    source_revision_id=fact.source_revision_id,
                    qualified=qualified,
                    estimated_lines=estimated_lines,
                    estimated_height_mm=round(estimated_height, 3),
                    matched_requirement_ids=fact.matched_requirement_ids,
                    qualification_reasons=tuple(qualification_reasons) if qualified else (),
                    exclusion_reasons=tuple(exclusion_reasons),
                    degradation_sources=fact.degradation_sources,
                )
            )
        return estimates

    def _measure_height(self, structured: dict[str, object]) -> float:
        report = self._layout.measure_resume_layout(
            structured,
            LayoutConstraint(
                max_pages=None,
                minimum_page_usage_ratio=0.0,
                target_page_usage_ratio=0.0,
                maximum_page_usage_ratio=1.0,
            ),
        )
        return sum(value.used_height_mm for value in report.pages)


def _supported_structure(
    experiences: tuple[RetrievalExperience, ...],
    qualified_facts: list[RankedFact],
    *,
    user_profile: dict[str, object] | None,
    language: str,
    include_contact: bool,
    include_education: bool,
    include_skills: bool,
    narrative_experience_ids: set[str],
    profile_version: str,
    profile_hash: str,
) -> dict[str, object]:
    facts_by_experience: dict[str, list[RankedFact]] = defaultdict(list)
    for fact in qualified_facts:
        facts_by_experience[fact.experience_id].append(fact)
    qualified_experience_ids = set(facts_by_experience)
    experience_by_id = {value.experience_id: value for value in experiences}
    sections: list[dict[str, object]] = []

    if include_education:
        education_items = [
            _experience_item(value, raw_text=value.content)
            for value in experiences
            if value.category == "education"
        ]
        if education_items:
            sections.append(
                {
                    "id": "sufficiency-education",
                    "type": "education",
                    "heading": "教育经历" if language.lower().startswith("zh") else "Education",
                    "items": education_items,
                }
            )

    if narrative_experience_ids:
        section_groups = (
            ("experience", {"work"}, "工作经历", "Experience"),
            ("project", {"project"}, "项目经历", "Projects"),
            ("other", {"volunteer", "other"}, "其他经历", "Other Experience"),
        )
        for section_type, categories, zh_heading, en_heading in section_groups:
            items = [
                _experience_item(experience_by_id[experience_id])
                for experience_id in narrative_experience_ids
                if experience_id in experience_by_id
                and experience_by_id[experience_id].category in categories
            ]
            if items:
                sections.append(
                    {
                        "id": f"sufficiency-{section_type}",
                        "type": section_type,
                        "heading": zh_heading if language.lower().startswith("zh") else en_heading,
                        "items": items,
                    }
                )

    if include_skills:
        skills = {
            value.strip()
            for fact in qualified_facts
            for value in fact.technologies
            if value.strip()
        }
        skills.update(
            value.strip()
            for experience in experiences
            if experience.experience_id in qualified_experience_ids
            or experience.category == "education"
            for value in experience.tags
            if value.strip()
        )
        if skills:
            sections.append(
                {
                    "id": "sufficiency-skills",
                    "type": "skills",
                    "heading": "技能" if language.lower().startswith("zh") else "Skills",
                    "items": [
                        {
                            "id": "sufficiency-skills-item",
                            "raw_text": " · ".join(sorted(skills, key=str.casefold)),
                            "bullets": [],
                        }
                    ],
                }
            )

    profile = user_profile or {}
    contact = None
    if include_contact and any(
        profile.get(value) for value in ("full_name", "phone", "email", "location", "linkedin_url")
    ):
        contact = {
            "name": profile.get("full_name"),
            "phone": profile.get("phone"),
            "email": profile.get("email"),
            "location": profile.get("location"),
            "linkedin": profile.get("linkedin_url"),
        }
    return {
        "language": language,
        "contact": contact,
        "sections": sections,
        "layout_profile_version": profile_version,
        "layout_profile_hash": profile_hash,
    }


def _experience_item(
    experience: RetrievalExperience,
    *,
    raw_text: str | None = None,
) -> dict[str, object]:
    return {
        "id": f"sufficiency-item-{experience.experience_id}",
        "source_experience_id": experience.experience_id,
        "title": experience.title,
        "organization": experience.organization,
        "role": experience.role,
        "start_date": experience.start_date.isoformat() if experience.start_date else None,
        "end_date": experience.end_date.isoformat() if experience.end_date else None,
        "raw_text": raw_text,
        "bullets": [],
    }


def _normalize_source(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())
