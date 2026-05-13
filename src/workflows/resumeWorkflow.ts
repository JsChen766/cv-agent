import { Workflow } from "../core/workflow/Workflow.js";

export const resumeWorkflow = new Workflow({
  id: "resume-workflow",
  name: "Resume Workflow",
  steps: [
    { type: "agent", name: "Analyze JD", agentName: "strategist" },
    { type: "agent", name: "Draft Resume Bullets", agentName: "architect" },
    { type: "agent", name: "Review Draft", agentName: "critic" }
  ]
});
