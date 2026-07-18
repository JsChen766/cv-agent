"""Print or verify the frontend resume-template manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from app.domain.resume.layout_templates import RESUME_TEMPLATE_REGISTRY

MANIFEST_PATH = Path("contracts/resume-layout-templates-v1.json")


def build_manifest() -> dict[str, Any]:
    return {
        "schema_version": "resume-layout-templates-v1",
        "templates": [
            template.frontend_manifest() for template in RESUME_TEMPLATE_REGISTRY.values()
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generated = build_manifest()
    if args.check:
        committed = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        if committed != generated:
            raise SystemExit("Resume layout manifest is stale")
        return 0
    print(json.dumps(generated, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
