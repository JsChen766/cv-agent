export { PreferenceBankService, type PreferenceBankServiceDeps } from "./PreferenceBankService.js";
export {
  InMemoryPreferenceRepository,
  type PreferenceListOptions,
  type PreferenceRepository,
} from "./PreferenceRepository.js";
export { PostgresPreferenceRepository } from "./PostgresPreferenceRepository.js";
export { PreferenceSignalExtractor, type PreferenceSignalEnrichment } from "./PreferenceSignalExtractor.js";
export { PreferenceConsolidator } from "./PreferenceConsolidator.js";
export {
  PreferenceContextProvider,
  PreferenceMemoryProvider,
  PreferenceReflectionSink,
  PreferenceRetrievalProvider,
  createPreferenceCapabilityModule,
} from "./PreferenceCapability.js";
export type {
  ExperienceAffinity,
  PersonalizationPack,
  PreferenceDimension,
  PreferenceEventRecord,
  PreferenceInstruction,
  PreferenceScope,
  PreferenceSignal,
  PreferenceStatus,
  PreferenceUpdateResult,
  UserPreference,
} from "./types.js";
