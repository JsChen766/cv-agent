import { ArchivistAgent } from "../agents/ArchivistAgent.js";
import { ModelClient } from "../core/model/ModelClient.js";
import { MockProvider } from "../providers/MockProvider.js";

const modelClient = new ModelClient({
  provider: new MockProvider(),
  defaultModel: "mock-model"
});

const agent = new ArchivistAgent({ modelClient });
const output = await agent.run({
  content: "我在 2025 年负责把旧的简历编辑器迁移到 TypeScript，并补齐了关键单元测试。"
});

console.log(JSON.stringify(output, null, 2));
