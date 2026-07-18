#!/usr/bin/env python3
"""Capture a reviewed, PII-free resume regression fixture from JSON exports.

The script intentionally does not connect to production databases and never
redacts text automatically. Export a run/variant as JSON, prepare any required
width-preserving replacements, then run this tool locally.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

MANIFEST_SCHEMA = "resume-regression-manifest-v1"
EXPECTED_SCHEMA = "resume-regression-expected-v1"
CASE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,79}$")
EMAIL_PATTERN = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
PHONE_PATTERN = re.compile(r"(?<!\w)(?:\+?\d[\s().-]){7,}\d(?!\w)")
SECRET_PATTERN = re.compile(r"\b(?:sk|api[_-]?key|token)[_-][A-Za-z0-9_-]{12,}\b", re.IGNORECASE)


class CaptureError(ValueError):
    """Raised when a capture would violate the fixture contract."""


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_hash(value: object) -> str:
    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CaptureError(f"JSON input does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CaptureError(f"Invalid JSON in {path}: {exc}") from exc


def require_mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise CaptureError(f"{label} must be a JSON object")
    return {str(key): item for key, item in value.items()}


def nested_mapping(source: Mapping[str, Any], *path: str) -> dict[str, Any] | None:
    current: object = source
    for key in path:
        if not isinstance(current, Mapping) or key not in current:
            return None
        current = current[key]
    if not isinstance(current, Mapping):
        return None
    return {str(key): value for key, value in current.items()}


def first_mapping(
    source: Mapping[str, Any], paths: Sequence[tuple[str, ...]]
) -> dict[str, Any] | None:
    for path in paths:
        value = nested_mapping(source, *path)
        if value is not None:
            return value
    return None


def find_pii(value: object) -> list[str]:
    """Return stable categories for common unsafe strings without echoing them."""
    matches: set[str] = set()

    def visit(item: object) -> None:
        if isinstance(item, Mapping):
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)
        elif isinstance(item, str):
            for email in EMAIL_PATTERN.findall(item):
                domain = email.rsplit("@", 1)[-1].lower()
                if not (domain.endswith(".test") or domain == "example.com"):
                    matches.add("email")
            for url in URL_PATTERN.findall(item):
                lowered = url.lower()
                if "example.test" not in lowered and "example.com" not in lowered:
                    matches.add("url")
            if PHONE_PATTERN.search(item):
                matches.add("phone")
            if SECRET_PATTERN.search(item):
                matches.add("secret")

    visit(value)
    return sorted(matches)


def validate_provenance(
    structured: Mapping[str, Any],
    *,
    provenance: str,
    attest_no_real_pii: bool,
    attest_width_preserving: bool,
    case_id: str,
) -> None:
    if not attest_no_real_pii:
        raise CaptureError("--attest-no-real-pii is required before writing a fixture")
    declaration = require_mapping(structured.get("fixture_provenance"), "fixture_provenance")
    if declaration.get("kind") != provenance:
        raise CaptureError("CLI provenance must match structured.fixture_provenance.kind")
    if declaration.get("contains_real_person_data") is not False:
        raise CaptureError("fixture_provenance must declare contains_real_person_data=false")
    if provenance == "authorized_width_preserving" and not attest_width_preserving:
        raise CaptureError(
            "authorized capture requires --attest-width-preserving; automatic redaction is forbidden"
        )
    if case_id == "incident_two_page_zh" and provenance == "synthetic":
        raise CaptureError(
            "incident_two_page_zh cannot be populated by synthetic data; keep it pending until real, "
            "authorized width-preserving evidence exists"
        )


def validate_dom(dom: Mapping[str, Any], structured: Mapping[str, Any], provenance: str) -> None:
    if dom.get("measurementVersion") != "browser-layout-observation-v1":
        raise CaptureError("DOM input must use browser-layout-observation-v1")
    if dom.get("profileHash") != structured.get("layout_profile_hash"):
        raise CaptureError("DOM and structured profile hashes differ")
    bullets = dom.get("bullets")
    if not isinstance(bullets, list) or not bullets:
        raise CaptureError("DOM input must contain at least one bullet measurement")
    if provenance == "authorized_width_preserving" and dom.get("measurementSource") == (
        "synthetic_boundary_fixture"
    ):
        raise CaptureError("authorized incident captures cannot use synthetic DOM measurements")


def write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as temporary:
            temporary.write(rendered)
            temporary_name = temporary.name
        os.replace(temporary_name, path)
    finally:
        if temporary_name is not None:
            temporary_path = Path(temporary_name)
            if temporary_path.exists():
                temporary_path.unlink()


def extract_bundle(source: Mapping[str, Any]) -> dict[str, dict[str, Any] | None]:
    structured = first_mapping(
        source,
        (
            ("structured",),
            ("payload_snapshot",),
            ("variant", "structured"),
            ("run", "payload_snapshot"),
        ),
    )
    constraint = first_mapping(
        source,
        (("layout_constraint",), ("layoutConstraint",), ("run", "layout_constraint")),
    )
    report = first_mapping(
        source,
        (("layout_report",), ("layoutReport",), ("run", "layout_report")),
    )
    if structured is None or constraint is None or report is None:
        raise CaptureError(
            "source export must provide structured/payload_snapshot, layout_constraint, and "
            "layout_report"
        )
    return {
        "structured": structured,
        "layout_constraint": constraint,
        "layout_report": report,
        "dom_preview": first_mapping(source, (("dom_preview",), ("domPreview",))),
        "dom_print": first_mapping(source, (("dom_print",), ("domPrint",))),
        "expected": first_mapping(source, (("expected",),)),
    }


def update_manifest(
    manifest_path: Path,
    *,
    case_entry: Mapping[str, Any],
    profile_version: str,
    profile_hash: str,
) -> None:
    if manifest_path.exists():
        manifest = require_mapping(read_json(manifest_path), "manifest")
    else:
        manifest = {
            "schema_version": MANIFEST_SCHEMA,
            "profile": {"version": profile_version, "hash": profile_hash},
            "cases": [],
        }
    if manifest.get("schema_version") != MANIFEST_SCHEMA:
        raise CaptureError(f"unsupported manifest schema: {manifest.get('schema_version')!r}")
    cases = manifest.get("cases")
    if not isinstance(cases, list):
        raise CaptureError("manifest.cases must be an array")
    replacement = dict(case_entry)
    updated = [
        case
        for case in cases
        if not isinstance(case, Mapping) or case.get("id") != replacement["id"]
    ]
    updated.append(replacement)
    updated.sort(key=lambda case: str(case.get("id", "")) if isinstance(case, Mapping) else "")
    manifest["cases"] = updated
    write_json_atomic(manifest_path, manifest)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Capture a canonical, reviewed resume regression fixture from a JSON export."
    )
    parser.add_argument("--source", type=Path, required=True, help="Run/variant JSON export")
    parser.add_argument("--case-id", required=True, help="Stable lowercase fixture case ID")
    parser.add_argument(
        "--fixtures-root",
        type=Path,
        default=Path("tests/fixtures/resume_regression"),
        help="Fixture root (default: tests/fixtures/resume_regression)",
    )
    parser.add_argument("--manifest", type=Path, help="Manifest path; defaults under fixtures root")
    parser.add_argument("--dom-input", type=Path, help="Separate preview DOM observation JSON")
    parser.add_argument("--dom-print-input", type=Path, help="Separate print DOM observation JSON")
    parser.add_argument(
        "--provenance",
        required=True,
        choices=("synthetic", "authorized_width_preserving"),
        help="Must match structured.fixture_provenance.kind",
    )
    parser.add_argument("--language", help="Manifest language; defaults to structured.language")
    parser.add_argument(
        "--density", default="unknown", choices=("sparse", "medium", "dense", "unknown")
    )
    parser.add_argument("--tag", action="append", default=[], help="Repeatable manifest tag")
    parser.add_argument(
        "--expectation", choices=("known_bad", "expected_pass"), default="known_bad"
    )
    parser.add_argument(
        "--attest-no-real-pii",
        action="store_true",
        help="Confirm the export contains no real-person or private data",
    )
    parser.add_argument(
        "--attest-width-preserving",
        action="store_true",
        help="Confirm authorized replacements preserve character classes and approximate widths",
    )
    parser.add_argument(
        "--overwrite", action="store_true", help="Replace an existing case directory"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not CASE_ID_PATTERN.fullmatch(args.case_id):
        raise CaptureError(
            "case ID must be 2-80 lowercase letters, digits, underscores, or hyphens"
        )
    source = require_mapping(read_json(args.source), "source export")
    bundle = extract_bundle(source)
    structured = require_mapping(bundle["structured"], "structured")
    validate_provenance(
        structured,
        provenance=args.provenance,
        attest_no_real_pii=args.attest_no_real_pii,
        attest_width_preserving=args.attest_width_preserving,
        case_id=args.case_id,
    )

    if args.dom_input:
        bundle["dom_preview"] = require_mapping(read_json(args.dom_input), "DOM preview input")
    if args.dom_print_input:
        bundle["dom_print"] = require_mapping(read_json(args.dom_print_input), "DOM print input")
    dom_preview = bundle["dom_preview"]
    if dom_preview is None:
        raise CaptureError(
            "a valid captured fixture requires a preview DOM observation; keep an unobserved "
            "incident pending instead of creating a partial valid case"
        )
    validate_dom(dom_preview, structured, args.provenance)

    unsafe_categories = find_pii(bundle)
    if unsafe_categories:
        categories = ", ".join(unsafe_categories)
        raise CaptureError(
            f"capture refused: possible {categories} detected; prepare a reviewed width-preserving "
            "source instead of redacting during capture"
        )

    case_dir = args.fixtures_root / args.case_id
    if case_dir.exists() and any(case_dir.iterdir()) and not args.overwrite:
        raise CaptureError(f"case already exists: {case_dir}; pass --overwrite after review")

    profile_version = str(structured.get("layout_profile_version") or "")
    profile_hash = str(structured.get("layout_profile_hash") or "")
    if not profile_version or not profile_hash:
        raise CaptureError("structured input must include layout profile version and hash")
    expected = dict(bundle["expected"] or {})
    expected.update(
        {
            "schema_version": EXPECTED_SCHEMA,
            "case_id": args.case_id,
            "baseline_status": args.expectation,
            "provenance": args.provenance,
        }
    )
    if bundle["expected"] is None:
        expected["review_required"] = True
    dom_print = bundle["dom_print"] or {
        "caseId": args.case_id,
        "surface": "print",
        "status": "pending",
        "reason": "No reviewed print observation was supplied during capture",
    }
    files: dict[str, object] = {
        "structured.json": structured,
        "layout-constraint.json": require_mapping(bundle["layout_constraint"], "layout_constraint"),
        "layout-report.json": require_mapping(bundle["layout_report"], "layout_report"),
        "dom-print.json": dom_print,
        "expected.json": expected,
    }
    files["dom-preview.json"] = dom_preview
    for filename, value in files.items():
        write_json_atomic(case_dir / filename, value)

    relative_files = {
        filename.removesuffix(".json").replace("-", "_"): f"{args.case_id}/{filename}"
        for filename in files
    }
    file_hashes = {filename: canonical_hash(value) for filename, value in files.items()}
    manifest_path = args.manifest or args.fixtures_root / "manifest.json"
    update_manifest(
        manifest_path,
        case_entry={
            "id": args.case_id,
            "language": args.language or structured.get("language") or "unknown",
            "density": args.density,
            "profile_hash": profile_hash,
            "provenance": args.provenance,
            "status": "valid",
            "p0_expectation": args.expectation,
            "tags": sorted(set(args.tag)),
            "files": relative_files,
            "canonical_hashes": file_hashes,
        },
        profile_version=profile_version,
        profile_hash=profile_hash,
    )
    print(
        json.dumps(
            {
                "case_id": args.case_id,
                "manifest": str(manifest_path),
                "files": sorted(files),
                "status": "captured",
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CaptureError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
