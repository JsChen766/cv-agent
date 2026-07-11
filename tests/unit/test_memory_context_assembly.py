from __future__ import annotations

from app.memory.context_assembly import AssembledContext, _trim_context


def test_context_budget_trims_state_before_prompt_generation() -> None:
    context = AssembledContext(
        jd_text="J" * 1000,
        experiences=[{"id": "exp-1", "content": "E" * 1000}],
        guideline_instructions=["G" * 500],
        preferences=[{"rule": "P" * 500, "category": "tone"}],
        user_profile={"full_name": "User"},
        evidence_pack=None,
    )

    trimmed = _trim_context(context, token_budget=100)

    assert len(trimmed.jd_text or "") <= 120
    assert len(str(trimmed.experiences[0]["content"])) <= 200
    assert len(trimmed.guideline_instructions[0]) <= 40
    assert len(str(trimmed.preferences[0]["rule"])) <= 40


def test_zero_context_budget_removes_optional_generation_context() -> None:
    context = AssembledContext("JD", [{"content": "experience"}], ["rule"], [], {}, None)

    trimmed = _trim_context(context, token_budget=0)

    assert trimmed.to_prompt_block() == ""
