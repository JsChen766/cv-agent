from __future__ import annotations

import asyncio
from collections.abc import Mapping

from pydantic import JsonValue

from app.domain.resume.models import ResumeItemCreate, ResumeItemPatch
from app.providers.factory import get_provider
from app.tools.actions.models import (
    ExportResumeInput,
    GenerateArtifactInput,
    JsonObject,
    OptimizeResumeItemInput,
    ProductActionResult,
    RewriteExperienceInput,
    VariantInput,
)
from app.tools.base import ServiceContainer


def _workspace(base: Mapping[str, JsonValue] | None = None) -> JsonObject:
    return dict(base or {})


async def optimize_resume_item(
    services: ServiceContainer,
    user_id: str,
    payload: OptimizeResumeItemInput,
    *,
    base_workspace: Mapping[str, JsonValue] | None = None,
) -> ProductActionResult:
    item = await services.resume.get_item_by_id(user_id, payload.resumeItemId)
    provider = get_provider()
    instruction = payload.instruction or "Improve clarity, specificity, and measurable impact."
    result = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    "You are a senior resume editor. Rewrite only the provided resume item. "
                    "Keep facts grounded in the original text; do not invent employers, metrics, or technologies."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Instruction: {instruction}\n\n"
                    f"Title: {item.title or ''}\n\n"
                    f"Current content:\n{item.content_snapshot}"
                ),
            },
        ],
        temperature=0.3,
        max_tokens=900,
    )
    optimized = result if isinstance(result, str) else item.content_snapshot
    updated = await services.resume.update_item_by_id(
        user_id,
        payload.resumeItemId,
        ResumeItemPatch(content_snapshot=optimized.strip()),
    )
    workspace = _workspace(base_workspace)
    workspace["resume_id"] = updated.resume_id
    workspace["resume_item_id"] = updated.id
    return ProductActionResult(
        message="Resume item optimized.",
        workspace=workspace,
        data={"resumeItemId": updated.id, "resumeId": updated.resume_id},
    )


async def rewrite_experience(
    services: ServiceContainer,
    user_id: str,
    payload: RewriteExperienceInput,
    *,
    base_workspace: Mapping[str, JsonValue] | None = None,
) -> ProductActionResult:
    experience = await services.experience.get_experience(user_id, payload.experienceId)
    source_content = experience.current_revision.content if experience.current_revision else ""
    provider = get_provider()
    instruction = payload.instruction or "Rewrite this experience as concise, resume-ready bullets."
    result = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    "You rewrite career experience notes into resume-ready Markdown. "
                    "Preserve the factual scope of the original content and avoid unsupported claims."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Instruction: {instruction}\n\n"
                    f"Experience: {experience.title}\n"
                    f"Organization: {experience.organization or ''}\n\n"
                    f"Original content:\n{source_content}"
                ),
            },
        ],
        temperature=0.3,
        max_tokens=1200,
    )
    rewritten = result if isinstance(result, str) else source_content
    revision = await services.experience.add_revision(
        user_id,
        payload.experienceId,
        rewritten.strip(),
        source="ai_generated",
    )
    workspace = _workspace(base_workspace)
    workspace["experience_id"] = experience.id
    return ProductActionResult(
        message=f"Experience rewritten and saved as revision {revision.id}.",
        workspace=workspace,
        data={"experienceId": experience.id, "revisionId": revision.id},
    )


async def accept_variant(
    services: ServiceContainer,
    user_id: str,
    payload: VariantInput,
    *,
    base_workspace: Mapping[str, JsonValue] | None = None,
) -> ProductActionResult:
    variant = await services.resume.get_acceptable_variant(user_id, payload.variantId)
    resume = await services.resume.get_resume(user_id, variant.resume_id)
    item = next(
        (candidate for candidate in resume.items if candidate.source_variant_id == variant.id),
        None,
    )
    if item is None:
        item = await services.resume.add_item(
            user_id,
            variant.resume_id,
            ResumeItemCreate(
                section_type="other",
                title=variant.title,
                content_snapshot=variant.content,
                hidden=True,
                source_variant_id=variant.id,
            ),
        )
    workspace = _workspace(base_workspace)
    workspace["resume_id"] = variant.resume_id
    workspace["variant_id"] = variant.id
    workspace["resume_item_id"] = item.id
    return ProductActionResult(
        message="Variant accepted and saved to the resume.",
        workspace=workspace,
        data={"resumeId": variant.resume_id, "variantId": variant.id, "resumeItemId": item.id},
    )


async def show_evidence(
    services: ServiceContainer,
    user_id: str,
    payload: VariantInput,
    *,
    base_workspace: Mapping[str, JsonValue] | None = None,
) -> ProductActionResult:
    variant = await services.resume.get_variant(payload.variantId)
    await services.resume.get_resume(user_id, variant.resume_id)
    evidence_lines = [
        f"- {item.requirement_text}: {', '.join(item.supporting_claims) or 'No supporting claim recorded.'}"
        for item in variant.evidence_summary
    ]
    risk_lines = [f"- {item.severity}: {item.text}" for item in variant.risk_summary]
    missing_lines = [f"- {item}" for item in variant.missing_info]
    sections = [
        "Evidence summary:",
        *(evidence_lines or ["- No evidence records are attached to this variant yet."]),
        "",
        "Risks:",
        *(risk_lines or ["- No risks recorded."]),
        "",
        "Missing information:",
        *(missing_lines or ["- No missing information recorded."]),
    ]
    workspace = _workspace(base_workspace)
    workspace["resume_id"] = variant.resume_id
    workspace["variant_id"] = variant.id
    return ProductActionResult(
        message="\n".join(sections),
        workspace=workspace,
        data={"resumeId": variant.resume_id, "variantId": variant.id},
    )


async def generate_artifact(
    services: ServiceContainer,
    user_id: str,
    payload: GenerateArtifactInput,
    *,
    base_workspace: Mapping[str, JsonValue] | None = None,
) -> ProductActionResult:
    provider = get_provider()
    instruction = payload.instruction or f"Generate a {payload.artifactType} artifact."
    workspace = _workspace(base_workspace)
    jd_id = workspace.get("jd_id")
    experience_ids = workspace.get("experience_ids")
    jd_awaitable = (
        services.jd.get_jd(user_id, jd_id)
        if isinstance(jd_id, str)
        else asyncio.sleep(0, result=None)
    )
    jd, experience_context, profile, preferences = await asyncio.gather(
        jd_awaitable,
        _load_experience_context(
            services,
            user_id,
            [str(item) for item in experience_ids] if isinstance(experience_ids, list) else None,
        ),
        services.user.get_profile(user_id),
        services.preference.get_active_preferences(user_id),
    )
    experiences, resolved_experience_ids = experience_context

    context_parts = [f"Task: {instruction}"]
    if jd is not None:
        context_parts.append(f"Job description ({jd.title}):\n{jd.raw_text[:3000]}")
    if experiences:
        context_parts.append("Grounded experience context:\n" + "\n\n".join(experiences))
    if preferences:
        context_parts.append(
            "User preferences:\n" + "\n".join(f"- {item.rule}" for item in preferences[:8])
        )
    language = "Chinese (Simplified)" if "zh" in profile.preferred_language else "English"
    content = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    "You create polished career artifacts in Markdown. "
                    "Keep claims grounded in the available user context and avoid inventing specifics. "
                    f"Write in {language}."
                ),
            },
            {"role": "user", "content": "\n\n".join(context_parts)},
        ],
        temperature=0.5,
        max_tokens=1600,
    )
    content_str = content if isinstance(content, str) else ""
    title = payload.title or _artifact_title(payload.artifactType)
    artifact = await services.artifact.create_artifact(
        user_id,
        {
            "type": payload.artifactType,
            "title": title,
            "content": content_str.strip(),
            "source_jd_id": jd_id if isinstance(jd_id, str) else None,
            "source_experience_ids": resolved_experience_ids,
        },
    )
    workspace["artifact_id"] = artifact.id
    return ProductActionResult(
        message="Artifact generated.",
        workspace=workspace,
        data={"artifactId": artifact.id, "title": artifact.title, "wordCount": artifact.word_count},
    )


async def export_resume(
    services: ServiceContainer,
    user_id: str,
    payload: ExportResumeInput,
    *,
    base_workspace: Mapping[str, JsonValue] | None = None,
) -> ProductActionResult:
    resume = await services.resume.get_resume(user_id, payload.resumeId)
    variants = await services.resume.list_variants(resume.id)
    workspace = _workspace(base_workspace)
    workspace["resume_id"] = resume.id
    receipt: JsonObject = {
        "resumeId": resume.id,
        "title": resume.title,
        "status": resume.status,
        "itemCount": len(resume.items),
        "variantCount": len(variants),
        "exportMode": "browser_print_pdf",
    }
    workspace["export"] = receipt
    return ProductActionResult(
        message=(
            "Resume export package prepared. Use the browser print-to-PDF flow to generate the final PDF."
        ),
        workspace=workspace,
        data=receipt,
    )


async def _load_experience_context(
    services: ServiceContainer,
    user_id: str,
    experience_ids: list[str] | None = None,
    *,
    limit: int = 6,
) -> tuple[list[str], list[str]]:
    if experience_ids is None:
        listed, _ = await services.experience.list_experiences(user_id, limit=limit)
        experience_ids = [experience.id for experience in listed]
    else:
        experience_ids = experience_ids[:limit]
    experiences = await asyncio.gather(
        *(
            services.experience.get_experience(user_id, experience_id)
            for experience_id in experience_ids
        )
    )
    context = []
    for experience in experiences:
        content = experience.current_revision.content if experience.current_revision else ""
        context.append(
            f"- {experience.title} at {experience.organization or 'N/A'}\n{content[:1200]}"
        )
    return context, experience_ids


def _artifact_title(artifact_type: str) -> str:
    titles = {
        "cover_letter": "Cover Letter",
        "self_intro": "Self Introduction",
        "match_report": "JD Match Report",
        "interview_prep": "Interview Prep",
        "linkedin_summary": "LinkedIn Summary",
    }
    return titles.get(artifact_type, "Career Artifact")
