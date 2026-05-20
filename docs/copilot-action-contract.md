# Copilot Action Contract

`/copilot/actions` executes product actions emitted in `nextActions` and `variant.actions`.
The response shape stays the same as `/copilot/chat`: `assistantMessage`, `timeline`, `workspace`, `nextActions`, and `raw`.

## Supported Action Types

| Action type | Payload fields | Backend tool | Completion strategy |
| --- | --- | --- | --- |
| `accept` | `variantId`, `generationId`, `resumeId` | `save_variant_to_resume` | Backend saves the selected variant into a resume draft. |
| `reject` | `variantId`, `reason` | `record_variant_decision` | Backend records the decision. |
| `prefer` | `variantId`, `reason` | `record_variant_decision` | Backend records the decision. |
| `confirm_metric` | `variantId`, `metric`, `value`, `explanation` | `record_variant_decision` | Backend records the confirmation payload. |
| `revise_more_conservative` | `variantId`, `customInstruction` | `revise_variant` | Backend creates a conservative variant revision. |
| `revise_more_quantified` | `variantId`, `customInstruction` | `revise_variant` | Backend creates a quantified variant revision. |
| `show_evidence` | `variantId` | `show_evidence` | Backend returns evidence details for the variant. |
| `explain_choice` | `variantId` | `explain_choice` | Backend returns the recommendation rationale. |
| `generate_from_jd` | `jdId`, `targetRole` | `generate_resume_variants` | Backend generates variants from the selected JD. |
| `optimize_resume_item` | `resumeId`, `resumeItemId`, `selectedText`, `instruction` | `optimize_resume_item` | Backend returns a safe, model-assisted resume item rewrite suggestion. |
| `rewrite_experience` | `experienceId`, `selectedText`, `instruction` | `rewrite_experience` | Backend returns a safe, model-assisted experience rewrite suggestion. |
| `export_resume` | `resumeId`, `format`, `templateId` | `export_resume` | Backend creates an export job through `ResumeExportService` and returns export metadata. |

## Argument Resolution

`argsForAction` resolves IDs in this order:

1. `action.payload`
2. `clientState`
3. current `workspace`

For `generate_from_jd`, `jdId` is read from `payload.jdId`, then `clientState.activeJDId`, then `workspace.jdId`.
For resume and experience actions, selected text is read from `payload.selectedText`, then `clientState.selectedText`.

Missing required context must return `status: "needs_input"` from the tool instead of throwing.
Unknown or unregistered action tools return a safe failed response from `AgentRuntime.handleAction`.

## New Action Responses

`optimize_resume_item` uses `selectedText` first. If only `resumeId` and `resumeItemId` are present, it loads the resume item snapshot.
It asks the configured model client for a concise resume-ready rewrite and falls back to a deterministic suggestion if no model is available.
The tool must not invent metrics or facts, and it does not save the suggestion automatically.

`rewrite_experience` uses `selectedText` first. If only `experienceId` is present, it loads the current revision, or the newest revision by `createdAt` when there is no current revision.
It uses the same safe model-assisted rewrite path and falls back locally if needed.

`export_resume` returns:

- `timelineItems[0].type = "export_created"`
- `timelineItems[0].title = "Resume export created"`
- `timelineItems[0].relatedExportId`
- `workspacePatch.activeExportId`
- `workspacePatch.exportRecords[]`
- `raw.exportId`, `raw.jobId`, `raw.resumeId`, `raw.format`
- `raw.primaryActionResult`
- `raw.actionResults[]`
- `rawIds.decisionIds` containing the export id and job id

Example structured export response fields:

```json
{
  "workspace": {
    "activeExportId": "export-123",
    "exportRecords": [
      {
        "id": "export-123",
        "resumeId": "pres-123",
        "format": "html",
        "status": "pending",
        "jobId": "job-123"
      }
    ]
  },
  "raw": {
    "exportId": "export-123",
    "jobId": "job-123",
    "resumeId": "pres-123",
    "format": "html",
    "primaryActionResult": {
      "actionType": "export_resume",
      "status": "success",
      "message": "Created a HTML export job. It will be available in export records when ready.",
      "exportRecord": {
        "id": "export-123",
        "resumeId": "pres-123",
        "format": "html",
        "status": "pending",
        "jobId": "job-123"
      }
    }
  }
}
```

## Structured Action Result

`/copilot/actions` returns structured action status under `response.raw`:

- `response.raw.primaryActionResult`: the first tool result that includes an action result.
- `response.raw.actionResults`: all action results from tool execution.
- `actionResult.status`: `success`, `needs_input`, or `failed`.
- `actionResult.exportRecord`: structured export id, resume id, format, status, job id, and creation time.
- `actionResult.revisionSuggestion`: structured rewrite output for `optimize_resume_item` and `rewrite_experience`.

Frontend should read `raw.primaryActionResult` first. `assistantMessage` and timeline text are fallback display signals only.
`revisionSuggestion.rewrittenText` is capped by the backend and must not include provider raw payloads, cookies, tokens, or chain-of-thought.
`revisionSuggestion.sourceTextPreview` is capped to a short preview.

`export_created` is an official timeline type for successful export job creation.
`export_resume` is still recorded as Copilot activity type `decision` until the Postgres `copilot_activity.type` check constraint is migrated to include `export`.

## Export Entry Points

`export_resume` has two supported entry points:

1. Copilot action: used for natural language requests or Copilot action buttons. `/copilot/actions` executes the backend `export_resume` tool and creates the export job.
2. Product API: used for deterministic frontend export buttons. The frontend directly calls `POST /exports/resumes/:resumeId`.

Both are valid. The frontend must choose one path for a user gesture and must not trigger both paths for the same export.

## Frontend Fallback And Status

The frontend may still call product APIs directly for richer flows, but these action types are now backend-safe.
For Copilot actions, prefer these signals in order:

- HTTP error: route or auth level failure.
- `raw.primaryActionResult.status`: structured action outcome.
- Failed timeline item: action executed but failed.
- `assistantMessage` with a clear `needs_input` prompt: required context is missing.
- `workspace.exportRecords` and `raw.exportId`: export job was created.
- `timelineItems[].type === "revision_completed"`: rewrite suggestion was generated.

`export_resume` is backend-completed by creating an export job. If export creation fails, the assistant message directs the user back to the product export panel.

Frontend actions can include:

```json
{
  "type": "generate_from_jd",
  "payload": {
    "jdId": "pjd-123",
    "targetRole": "Frontend Engineer"
  }
}
```

`ProductAction.payload` is optional so existing actions without payload remain valid.
