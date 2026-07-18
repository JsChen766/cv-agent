from __future__ import annotations

import json
import re
import subprocess
import sys
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

import pytest

from app.domain.resume.layout_models import LayoutConstraint, LayoutReport

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "resume_regression"
MANIFEST_PATH = FIXTURE_ROOT / "manifest.json"
PROFILE_HASH = "6546b7a86dafbd62a72b82420ba5a4abf08634c6a59c32e1d575f4d1a8c20873"
VALID_CASE_IDS = {
    "zh_sparse",
    "zh_dense",
    "en_times_dense",
    "mixed_long_tech",
    "long_numeric_tokens",
    "tail_ratio_below_gate",
    "tail_ratio_at_gate",
}


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _manifest() -> dict[str, Any]:
    return _read(MANIFEST_PATH)


def _case(case_id: str) -> dict[str, Any]:
    return next(case for case in _manifest()["cases"] if case["id"] == case_id)


def _walk_bullets(structured: Mapping[str, Any]) -> Iterator[dict[str, Any]]:
    sections = structured.get("sections")
    assert isinstance(sections, list)
    for section in sections:
        assert isinstance(section, Mapping)
        items = section.get("items")
        assert isinstance(items, list)
        for item in items:
            assert isinstance(item, Mapping)
            bullets = item.get("bullets")
            assert isinstance(bullets, list)
            for bullet in bullets:
                assert isinstance(bullet, dict)
                yield bullet


def _dom_ratios(dom: Mapping[str, Any]) -> list[float]:
    bullets = dom.get("bullets")
    assert isinstance(bullets, list) and bullets
    ratios: list[float] = []
    ids: set[str] = set()
    for bullet in bullets:
        assert isinstance(bullet, Mapping)
        bullet_id = bullet["bulletId"]
        assert isinstance(bullet_id, str) and bullet_id not in ids
        ids.add(bullet_id)
        width = float(bullet["lastLineWidthPx"])
        available = float(bullet["availableLineWidthPx"])
        assert 0 <= width <= available
        ratios.append(width / available)
    return ratios


def test_manifest_and_all_valid_fixture_schemas_are_readable() -> None:
    manifest = _manifest()
    assert manifest["schema_version"] == "resume-regression-manifest-v1"
    assert manifest["profile"]["hash"] == PROFILE_HASH
    assert {case["id"] for case in manifest["cases"]} == VALID_CASE_IDS | {"incident_two_page_zh"}

    for case in manifest["cases"]:
        if case["status"] != "valid":
            continue
        assert case["id"] in VALID_CASE_IDS
        assert case["provenance"] == "synthetic"
        assert case["profile_hash"] == PROFILE_HASH
        files = case["files"]
        assert set(files) == {
            "structured",
            "layout_constraint",
            "layout_report",
            "dom_preview",
            "dom_print",
            "expected",
        }
        loaded = {name: _read(FIXTURE_ROOT / relative) for name, relative in files.items()}
        structured = loaded["structured"]
        assert structured["fixture_provenance"] == {
            "contains_real_person_data": False,
            "kind": "synthetic",
        }
        assert structured["layout_profile_hash"] == PROFILE_HASH
        constraint = LayoutConstraint.model_validate(loaded["layout_constraint"])
        assert constraint.max_pages == 1
        report = LayoutReport.model_validate(loaded["layout_report"])
        assert report.profile_hash == PROFILE_HASH
        assert loaded["dom_preview"]["profileHash"] == PROFILE_HASH
        assert loaded["dom_preview"]["measurementSource"] == "synthetic_boundary_fixture"
        assert loaded["dom_print"]["status"] == "pending"
        assert loaded["expected"]["case_id"] == case["id"]
        assert loaded["expected"]["baseline_status"] == case["p0_expectation"]

        structured_ids = {bullet["id"] for bullet in _walk_bullets(structured)}
        report_ids = {fit.bullet_id for fit in report.bullet_fits}
        dom_ids = {bullet["bulletId"] for bullet in loaded["dom_preview"]["bullets"]}
        assert structured_ids == report_ids == dom_ids
        for bullet in _walk_bullets(structured):
            assert bullet["source_fact_ids"]
            assert bullet["matched_jd_requirement_ids"]


def test_fixture_expectations_match_saved_backend_and_dom_boundaries() -> None:
    for case_id in VALID_CASE_IDS:
        case_dir = FIXTURE_ROOT / case_id
        report = _read(case_dir / "layout-report.json")
        dom = _read(case_dir / "dom-preview.json")
        expected = _read(case_dir / "expected.json")
        tolerance = float(expected["ratio_tolerance"])
        backend_expected = expected["backend"]
        dom_expected = expected["dom_preview"]

        assert report["status"] == backend_expected["status"]
        assert report["page_count"] <= backend_expected["max_page_count"]
        backend_usage = float(report["pages"][0]["usage_ratio"])
        if "min_page_usage_ratio" in backend_expected:
            assert backend_usage + tolerance >= backend_expected["min_page_usage_ratio"]
        if "max_page_usage_ratio" in backend_expected:
            assert backend_usage - tolerance <= backend_expected["max_page_usage_ratio"]

        ratios = _dom_ratios(dom)
        page_usage = float(dom["usedHeightPx"]) / float(dom["availableHeightPx"])
        assert dom["pageCount"] <= dom_expected["max_page_count"]
        if "min_tail_ratio" in dom_expected:
            assert min(ratios) + tolerance >= dom_expected["min_tail_ratio"]
        if "max_tail_ratio" in dom_expected:
            assert max(ratios) - tolerance <= dom_expected["max_tail_ratio"]
        if "min_page_usage_ratio" in dom_expected:
            assert page_usage + tolerance >= dom_expected["min_page_usage_ratio"]
        if "max_overflow_px" in dom_expected:
            assert dom["overflowPx"] <= dom_expected["max_overflow_px"]


def test_tail_ratio_cases_straddle_the_exact_gate() -> None:
    below = _dom_ratios(_read(FIXTURE_ROOT / "tail_ratio_below_gate" / "dom-preview.json"))
    at_gate = _dom_ratios(_read(FIXTURE_ROOT / "tail_ratio_at_gate" / "dom-preview.json"))

    assert below == pytest.approx([0.666], abs=1e-9)
    assert below[0] < 0.667
    assert at_gate == pytest.approx([0.667], abs=1e-9)
    assert at_gate[0] >= 0.667


def test_incident_case_is_pending_and_never_fabricated_as_real() -> None:
    incident = _case("incident_two_page_zh")
    assert incident["status"] == "invalid"
    assert incident["provenance"] == "not_captured"
    assert incident["p0_expectation"] == "pending"
    assert incident["profile_hash"] is None
    assert set(incident["files"]) == {"expected"}
    expected = _read(FIXTURE_ROOT / incident["files"]["expected"])
    assert expected["invalid"] is True
    assert expected["baseline_status"] == "pending"
    incident_dir = FIXTURE_ROOT / "incident_two_page_zh"
    assert not (incident_dir / "structured.json").exists()
    assert not (incident_dir / "layout-report.json").exists()
    assert not (incident_dir / "dom-preview.json").exists()


def test_synthetic_fixtures_contain_no_obvious_real_pii() -> None:
    email = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
    private_url = re.compile(r"https?://", re.IGNORECASE)
    phone = re.compile(r"(?<!\w)(?:\+?\d[\s().-]){7,}\d(?!\w)")
    for case_id in VALID_CASE_IDS:
        rendered = (FIXTURE_ROOT / case_id / "structured.json").read_text(encoding="utf-8")
        assert email.search(rendered) is None
        assert private_url.search(rendered) is None
        assert phone.search(rendered) is None
        assert 'contains_real_person_data": false' in rendered


def test_capture_script_reads_json_export_and_refuses_fake_incident(tmp_path: Path) -> None:
    source_case = FIXTURE_ROOT / "tail_ratio_at_gate"
    source = {
        "structured": _read(source_case / "structured.json"),
        "layout_constraint": _read(source_case / "layout-constraint.json"),
        "layout_report": _read(source_case / "layout-report.json"),
        "dom_preview": _read(source_case / "dom-preview.json"),
        "expected": _read(source_case / "expected.json"),
    }
    source_path = tmp_path / "export.json"
    source_path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
    fixture_root = tmp_path / "fixtures"
    script = PROJECT_ROOT / "scripts" / "capture_resume_regression_fixture.py"
    command = [
        sys.executable,
        str(script),
        "--source",
        str(source_path),
        "--case-id",
        "captured_synthetic",
        "--fixtures-root",
        str(fixture_root),
        "--provenance",
        "synthetic",
        "--attest-no-real-pii",
    ]
    completed = subprocess.run(
        command, cwd=PROJECT_ROOT, capture_output=True, text=True, check=False
    )
    assert completed.returncode == 0, completed.stderr
    assert (fixture_root / "captured_synthetic" / "structured.json").exists()
    captured_manifest = _read(fixture_root / "manifest.json")
    assert captured_manifest["cases"][0]["canonical_hashes"]

    fake_incident = command.copy()
    fake_incident[fake_incident.index("captured_synthetic")] = "incident_two_page_zh"
    refused = subprocess.run(
        fake_incident, cwd=PROJECT_ROOT, capture_output=True, text=True, check=False
    )
    assert refused.returncode == 2
    assert "cannot be populated by synthetic data" in refused.stderr


def test_benchmark_script_reads_json_and_uses_nearest_rank(tmp_path: Path) -> None:
    runs: list[dict[str, object]] = []
    for index in range(1, 23):
        runs.append(
            {
                "run_id": f"rgrun-synthetic-{index:02d}",
                "case_id": "tail_ratio_at_gate",
                "trigger": "chat_stream" if index % 2 else "chat",
                "status": "completed",
                "graph_duration_ms": index,
                "endpoint_duration_ms": index,
                "layout_report": {"profile_hash": PROFILE_HASH, "page_count": 1, "bullet_fits": []},
                "metrics": {
                    "nodes": [
                        {"node": "draft_generation", "started_offset_ms": 0, "duration_ms": index}
                    ],
                    "llm_calls": [
                        {
                            "started_offset_ms": 0,
                            "duration_ms": index,
                            "protocol_attempt_count": 1,
                            "physical_request_count": 1,
                            "input_tokens": 100,
                            "output_tokens": 50,
                        }
                    ],
                    "embedding_calls": [],
                    "database_calls": [],
                    "layout_calls": [],
                    "persistence_calls": [],
                },
                "layout_observations": [
                    {
                        "surface": "preview",
                        "profile_hash": PROFILE_HASH,
                        "page_count": 1,
                        "bullet_metrics": [],
                    }
                ],
            }
        )
    source = tmp_path / "runs.json"
    output = tmp_path / "baseline.json"
    source.write_text(
        json.dumps({"environment": {"git_commit": "synthetic"}, "runs": runs}), encoding="utf-8"
    )
    script = PROJECT_ROOT / "scripts" / "benchmark_resume_generation.py"
    completed = subprocess.run(
        [
            sys.executable,
            str(script),
            "--input",
            str(source),
            "--output",
            str(output),
            "--warmup",
            "2",
            "--runs",
            "20",
            "--require-dom",
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    report = _read(output)
    endpoint = report["aggregates"]["latency_ms"]["endpoint"]
    assert report["valid_run_count"] == 20
    assert report["baseline_status"] == "pending"
    assert endpoint == {
        "max": 22,
        "p50": 12,
        "p95": 21,
        "p95_published": True,
        "sample_count": 20,
    }


@pytest.mark.parametrize(
    "script_name",
    ["capture_resume_regression_fixture.py", "benchmark_resume_generation.py"],
)
def test_regression_scripts_have_local_help(script_name: str) -> None:
    completed = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "scripts" / script_name), "--help"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0
    assert "usage:" in completed.stdout


def test_committed_p0_baseline_does_not_publish_fabricated_percentiles() -> None:
    baseline = _read(PROJECT_ROOT / "docs" / "baselines" / "resume-generation-p0-baseline.json")
    assert baseline["baseline_status"] == "pending"
    assert baseline["valid_run_count"] == 0
    assert baseline["p95_published"] is False
    assert baseline["aggregates"] is None
    assert baseline["invalid_samples"]
