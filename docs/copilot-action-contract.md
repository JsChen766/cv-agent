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
| `optimize_resume_item` | `resumeId`, `resumeItemId`, `selectedText`, `instruction` | `optimize_resume_item` | Backend returns a safe text revision suggestion. |
| `rewrite_experience` | `experienceId`, `selectedText`, `instruction` | `rewrite_experience` | Backend returns a safe text rewrite suggestion. |
| `export_resume` | `resumeId`, `format`, `templateId` | `export_resume` | Backend creates an export job through `ResumeExportService`. |

## Argument Resolution

`argsForAction` resolves IDs in this order:

1. `action.payload`
2. `clientState`
3. current `workspace`

For `generate_from_jd`, `jdId` is read from `payload.jdId`, then `clientState.activeJDId`, then `workspace.jdId`.
For resume and experience actions, selected text is read from `payload.selectedText`, then `clientState.selectedText`.

Missing required context must return `status: "needs_input"` from the tool instead of throwing.
Unknown or unregistered action tools return a safe failed response from `AgentRuntime.handleAction`.

## Frontend Fallback

The frontend may still call product APIs directly for richer flows, but these action types are now backend-safe.
`export_resume` is backend-completed by creating an export job. If export creation fails, the assistant message should direct the user back to the product export panel.

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
