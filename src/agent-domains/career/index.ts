import type { AgentDomainModule } from "../../agent-core/domain/AgentDomainModule.js";
import { FrontDeskAgent } from "../../agent-core/agents/FrontDeskAgent.js";
import { ExperienceReceiverAgent } from "../../agent-core/agents/ExperienceReceiverAgent.js";
import { StrategistAgent } from "../../agent-core/agents/StrategistAgent.js";
import { ArchitectAgent } from "../../agent-core/agents/ArchitectAgent.js";
import { CriticAgent } from "../../agent-core/agents/CriticAgent.js";
import { createExperienceAgentTools } from "../../agent-tools/experience/index.js";
import { createJDAgentTools } from "../../agent-tools/jd/index.js";
import { createResumeAgentTools } from "../../agent-tools/resume/index.js";
import { createExportAgentTools } from "../../agent-tools/export/index.js";
import { createEvidenceAgentTools } from "../../agent-tools/evidence/index.js";
import { createWritingAgentTools } from "../../agent-tools/writing/index.js";

export const careerDomain: AgentDomainModule = {
  id: "career",
  agents: [
    { name: "frontdesk", create: (deps) => new FrontDeskAgent({ modelClient: deps.modelClient, promptRegistry: deps.promptRegistry }) },
    { name: "experience_receiver", create: (deps) => new ExperienceReceiverAgent({ modelClient: deps.modelClient, promptRegistry: deps.promptRegistry }) },
    { name: "strategist", create: (deps) => new StrategistAgent({ modelClient: deps.modelClient, promptRegistry: deps.promptRegistry }) },
    { name: "architect", create: (deps) => new ArchitectAgent({ modelClient: deps.modelClient, promptRegistry: deps.promptRegistry }) },
    { name: "critic", create: (deps) => new CriticAgent({ modelClient: deps.modelClient, promptRegistry: deps.promptRegistry }) },
  ],
  tools: [
    ...createExperienceAgentTools(),
    ...createJDAgentTools(),
    ...createResumeAgentTools(),
    ...createExportAgentTools(),
    ...createEvidenceAgentTools(),
    // Phase 2: register `compose_career_text` in the tool pool. NOT yet in
    // any specialist's allowedTools — Phase 3 will open Architect /
    // ExperienceReceiver to invoke it. Registration here makes the tool
    // available to ToolRegistry.list() so smoke tests, manual invocation,
    // and the Phase 6 LLM probe can exercise it without touching agent
    // contracts.
    ...createWritingAgentTools(),
  ],
};
