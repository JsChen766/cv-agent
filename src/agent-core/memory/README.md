# Agent Memory Extension Point

This directory intentionally contains only turn-scoped context providers for P12.

Future RAG, long-term memory, reflection, self-evaluation, and personalization should plug into `ContextProvider` implementations and feed `AgentContext.productContext` or agent-specific context blocks. Runtime code should not read vector stores or memory repositories directly.
