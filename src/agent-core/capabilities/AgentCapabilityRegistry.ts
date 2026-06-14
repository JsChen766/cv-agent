import type {
  AgentCapabilityModule,
  ContextProvider,
  EvaluationHook,
  MemoryProvider,
  ReflectionSink,
  RetrievalProvider,
} from "./AgentCapabilityModule.js";

export class AgentCapabilityRegistry {
  private readonly modules = new Map<string, AgentCapabilityModule>();

  public constructor(modules: readonly AgentCapabilityModule[] = []) {
    this.registerMany(modules);
  }

  public register(module: AgentCapabilityModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Duplicate capability module id "${module.id}".`);
    }
    this.modules.set(module.id, module);
  }

  public registerMany(modules: readonly AgentCapabilityModule[]): void {
    for (const module of modules) {
      this.register(module);
    }
  }

  public listModules(): AgentCapabilityModule[] {
    return [...this.modules.values()];
  }

  public listContextProviders(): ContextProvider[] {
    return this.listBy((module) => module.contextProviders);
  }

  public listRetrievalProviders(): RetrievalProvider[] {
    return this.listBy((module) => module.retrievalProviders);
  }

  public listMemoryProviders(): MemoryProvider[] {
    return this.listBy((module) => module.memoryProviders);
  }

  public listReflectionSinks(): ReflectionSink[] {
    return this.listBy((module) => module.reflectionSinks);
  }

  public listEvaluationHooks(): EvaluationHook[] {
    return this.listBy((module) => module.evaluationHooks);
  }

  private listBy<T>(select: (module: AgentCapabilityModule) => readonly T[] | undefined): T[] {
    return this.listModules().flatMap((module) => [...(select(module) ?? [])]);
  }
}
