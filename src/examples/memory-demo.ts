import { MemoryManager } from "../core/memory/MemoryManager.js";
import { FileSystemStorageAdapter } from "../core/storage/FileSystemStorageAdapter.js";

const memory = new MemoryManager(new FileSystemStorageAdapter(".data"));
const sessionId = "demo-session";

await memory.clear(sessionId);
await memory.appendMessage(sessionId, { role: "user", content: "我做过一个 Agent Runtime 项目。" });
await memory.appendMessage(sessionId, { role: "assistant", content: "已记录该经历。" });

console.log(JSON.stringify(await memory.getMessages(sessionId), null, 2));
