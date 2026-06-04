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
  ],
};
