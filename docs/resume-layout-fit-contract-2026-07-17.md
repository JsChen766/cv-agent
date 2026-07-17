# 简历 80%–95% 版面契约

## 后端生成保证

- 一页简历最低使用率：`0.80`
- 优化目标：`0.88`
- 最高使用率：`0.95`
- 初次生成返回候选内容池，后端确定性选择最终内容组合。
- 正常生成只调用一次简历 LLM；候选池不足时最多调用一次定向补写。
- 不在目标区间内的候选不得进入 `resume_review`。

## `resume.structured.layout_tuning`

最终结构化简历可能携带以下字段。前端预览和 print CSS 必须应用相同参数：

```json
{
  "layout_tuning": {
    "body_font_scale": 1.05,
    "body_line_height": 1.24,
    "section_gap_scale": 1.25,
    "item_gap_scale": 1.3,
    "bullet_gap_scale": 1.2
  }
}
```

同一结构还会返回：

```json
{
  "layout_usage_ratio": 0.881,
  "layout_target_band": {"minimum": 0.8, "target": 0.88, "maximum": 0.95}
}
```

允许范围：

| 字段 | 最小值 | 最大值 |
|---|---:|---:|
| `body_font_scale` | 1.00 | 1.08 |
| `body_line_height` | 1.18 | 1.28 |
| `section_gap_scale` | 1.00 | 1.50 |
| `item_gap_scale` | 1.00 | 1.60 |
| `bullet_gap_scale` | 1.00 | 1.50 |

## `resume_content_gap` interrupt

所有可验证内容、一次定向补写和允许的版式调节仍无法达到 80% 时，后端发送：

```json
{
  "event": "agent.interrupt",
  "type": "resume_content_gap",
  "current_usage_ratio": 0.68,
  "target_usage_ratio": 0.8,
  "missing_height_mm": 33.5,
  "approximate_missing_lines": 9,
  "suggestions": [
    {
      "experience_id": "exp-1",
      "title": "后端开发实习",
      "jd_match_score": 0.91,
      "questions": ["你具体负责了哪些模块、流程或交付物？"]
    }
  ],
  "action_options": [
    {"id": "supplement", "label": "补充经历"},
    {"id": "cancel", "label": "暂不补充"}
  ]
}
```

恢复 interrupt 时提交：

```json
{
  "action": "supplement",
  "experience_id": "exp-1",
  "content": "补充的、可验证的职责/方法/结果事实"
}
```

后端将内容保存为该经历的新 revision，并重新计算 JD 匹配预算和版面组合。

## 浏览器校准要求

后端以 `resume-template-v2` 字体和尺寸测量。前端必须使用同版本字体资产与打印 CSS，
并以浏览器实际使用率和后端报告相差不超过 2 个百分点作为上线门槛。在完成该校准前，
`RESUME_LAYOUT_HARD_GATE_ENABLED` 仍应保持关闭，但 80%–95% 的后端候选过滤继续生效。
