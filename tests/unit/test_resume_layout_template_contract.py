from __future__ import annotations

import json
from pathlib import Path

from scripts.export_resume_layout_templates import build_manifest


def test_frontend_layout_template_manifest_matches_domain_registry() -> None:
    committed = json.loads(
        Path("contracts/resume-layout-templates-v1.json").read_text(encoding="utf-8")
    )

    assert committed == build_manifest()
