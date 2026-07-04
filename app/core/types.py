from __future__ import annotations

from typing import Literal
from uuid import uuid4


# ── ID helpers ────────────────────────────────────────────────────────────────

def generate_id(prefix: str = "") -> str:
    """Generate a prefixed UUID string, e.g. 'thread-<uuid>'."""
    uid = str(uuid4())
    return f"{prefix}{uid}" if prefix else uid


# Prefix constants
THREAD_PREFIX = "thread-"
TURN_PREFIX = "turn-"
USER_PREFIX = "user-"
EXP_PREFIX = "exp-"
JD_PREFIX = "jd-"
RESUME_PREFIX = "resume-"
ARTIFACT_PREFIX = "artifact-"
VARIANT_PREFIX = "variant-"
PREF_PREFIX = "pref-"
FILE_PREFIX = "file-"
CANDIDATE_PREFIX = "cand-"
JOB_PREFIX = "job-"


# ── Shared enums / literals ───────────────────────────────────────────────────

RiskLevel = Literal["low", "medium", "high"]

CareerStage = Literal["student", "junior", "mid", "senior", "lead", "executive"]

ExperienceCategory = Literal["work", "project", "education", "volunteer", "other"]

ExperienceStatus = Literal["active", "archived"]

ImportCandidateStatus = Literal["pending", "accepted", "rejected"]

ImportSource = Literal["text", "file"]

ArtifactType = Literal[
    "cover_letter",
    "self_intro",
    "match_report",
    "interview_prep",
    "linkedin_summary",
    "other",
]

PreferenceSource = Literal["explicit", "rejection_signal", "edit_pattern"]

SignalType = Literal["explicit_statement", "rejection", "edit_diff"]

RouterTarget = Literal[
    "experience_import",
    "jd",
    "resume_generation",
    "artifact",
    "open_ended",
]
