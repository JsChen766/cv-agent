from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from pydantic import JsonValue

from app.domain.resume.models import ResumeItemCreate, ResumeItemPatch, ResumeVariantCreate
from app.providers.factory import get_provider
from app.tools.actions.models import (
    ExportResumeInput,
    GenerateArtifactInput,
    GenerateResumeFromJdInput,
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
    variant = await services.resume.get_variant(payload.variantId)
    await services.resume.get_resume(user_id, variant.resume_id)
    item = await services.resume.add_item(
        user_id,
        variant.resume_id,
        ResumeItemCreate(
            section_type="other",
            title=variant.title,
            content_snapshot=variant.content,
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
    content = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    "You create polished career artifacts in Markdown. "
                    "Keep claims grounded in the available user context and avoid inventing specifics."
                ),
            },
            {"role": "user", "content": instruction},
        ],
        temperature=0.5,
        max_tokens=1600,
    )
    content_str = content if isinstance(content, str) else ""
    title = payload.title or _artifact_title(payload.artifactType)
    workspace = _workspace(base_workspace)
    jd_id = workspace.get("jd_id")
    experience_ids = workspace.get("experience_ids")
    artifact = await services.artifact.create_artifact(
        user_id,
        {
            "type": payload.artifactType,
            "title": title,
            "content": content_str.strip(),
            "source_jd_id": jd_id if isinstance(jd_id, str) else None,
            "source_experience_ids": (
                [str(item) for item in experience_ids]
                if isinstance(experience_ids, list)
                else []
            ),
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


async def generate_resume_from_jd(
    services: ServiceContainer,
    user_id: str,
    payload: GenerateResumeFromJdInput,
    *,
    base_workspace: Mapping[str, JsonValue] | None = None,
) -> ProductActionResult:
    jd = await services.jd.get_jd(user_id, payload.jdId)
    resume_id = payload.resumeId
    if resume_id:
        resume = await services.resume.get_resume(user_id, resume_id)
    else:
        resume = await services.resume.create_resume(
            user_id,
            f"Resume for {jd.target_role or jd.title}",
            target_role=jd.target_role,
            jd_id=jd.id,
        )

    provider = get_provider()
    requirements = "\n".join(f"- {req.text}" for req in jd.requirements[:12])
    instruction = payload.instruction or "Generate a complete tailored resume in Markdown."
    content = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    "You are an expert resume writer. Generate a grounded, tailored resume in Markdown. "
                    "If user experience context is missing, write conservative placeholders rather than inventing facts."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Task: {instruction}\n\n"
                    f"JD title: {jd.title}\nCompany: {jd.company or ''}\n"
                    f"Target role: {jd.target_role or ''}\n\n"
                    f"JD text:\n{jd.raw_text[:3000]}\n\nRequirements:\n{requirements}"
                ),
            },
        ],
        temperature=0.5,
        max_tokens=3000,
    )
    content_str = content if isinstance(content, str) else ""
    variant = await services.resume.save_variant(
        resume.id,
        ResumeVariantCreate(
            jd_id=jd.id,
            title="AI Generated Variant",
            content=content_str.strip(),
        ),
    )
    workspace = _workspace(base_workspace)
    workspace["jd_id"] = jd.id
    workspace["resume_id"] = resume.id
    workspace["variant_id"] = variant.id
    data = cast(JsonValue, {"resumeId": resume.id, "jdId": jd.id, "variant": variant.model_dump(mode="json")})
    return ProductActionResult(
        message="I've generated a resume variant for review.",
        workspace=workspace,
        data=data,
    )


def _artifact_title(artifact_type: str) -> str:
    titles = {
        "cover_letter": "Cover Letter",
        "self_intro": "Self Introduction",
        "match_report": "JD Match Report",
        "interview_prep": "Interview Prep",
        "linkedin_summary": "LinkedIn Summary",
    }
    return titles.get(artifact_type, "Career Artifact")

