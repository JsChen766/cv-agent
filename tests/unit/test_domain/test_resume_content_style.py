from app.domain.resume.content_style import (
    find_terminal_period_violations,
    normalize_resume_narrative_punctuation,
    strip_terminal_sentence_period,
)


def test_strip_terminal_period_preserves_internal_dots() -> None:
    assert strip_terminal_sentence_period("将延迟降低至 1.5 秒。") == "将延迟降低至 1.5 秒"
    assert strip_terminal_sentence_period("Built API with Python 3.12.") == (
        "Built API with Python 3.12"
    )
    assert strip_terminal_sentence_period("详见 example.com") == "详见 example.com"
    assert strip_terminal_sentence_period("结果为 1.5") == "结果为 1.5"
    assert strip_terminal_sentence_period("完成迁移。】") == "完成迁移】"


def test_normalize_only_changes_narrative_fields_without_mutating_input() -> None:
    structured = {
        "contact": {"email": "alice@example.com"},
        "sections": [
            {
                "items": [
                    {
                        "id": "item-1",
                        "organization": "Example.com",
                        "raw_text": "GPA 3.8。",
                        "bullets": [
                            {"id": "bul-1", "text": "将错误率降低 2.5%。"},
                        ],
                    }
                ]
            }
        ],
    }

    normalized = normalize_resume_narrative_punctuation(structured)

    item = normalized["sections"][0]["items"][0]
    assert item["raw_text"] == "GPA 3.8"
    assert item["bullets"][0]["text"] == "将错误率降低 2.5%"
    assert item["organization"] == "Example.com"
    assert normalized["contact"]["email"] == "alice@example.com"
    assert structured["sections"][0]["items"][0]["raw_text"] == "GPA 3.8。"


def test_find_terminal_period_violations_returns_stable_targets() -> None:
    structured = {
        "sections": [
            {
                "id": "sec-1",
                "items": [
                    {
                        "id": "item-1",
                        "raw_text": "课程：数据库。",
                        "bullets": [
                            {"id": "bul-1", "text": "完成服务拆分。"},
                            {"id": "bul-2", "text": "实现监控告警"},
                        ],
                    }
                ],
            }
        ]
    }

    violations = find_terminal_period_violations(structured)

    assert [(value.field, value.item_id, value.bullet_id) for value in violations] == [
        ("raw_text", "item-1", None),
        ("bullet", "item-1", "bul-1"),
    ]
