import type {
  PreferenceEventRecord,
  PreferenceStatus,
  UserPreference,
} from "./types.js";

export type PreferenceListOptions = {
  statuses?: PreferenceStatus[];
  limit?: number;
};

export interface PreferenceRepository {
  saveEvent(event: PreferenceEventRecord): Promise<{ event: PreferenceEventRecord; inserted: boolean }>;
  getPreferenceByIdentity(userId: string, identityKey: string): Promise<UserPreference | null>;
  upsertPreference(preference: UserPreference): Promise<UserPreference>;
  listPreferences(userId: string, options?: PreferenceListOptions): Promise<UserPreference[]>;
  touchPreferences(userId: string, preferenceIds: string[], usedAt: string): Promise<number>;
}

export class InMemoryPreferenceRepository implements PreferenceRepository {
  private readonly events = new Map<string, PreferenceEventRecord>();
  private readonly eventIdsByDedupeKey = new Map<string, string>();
  private readonly preferences = new Map<string, UserPreference>();

  public async saveEvent(event: PreferenceEventRecord): Promise<{ event: PreferenceEventRecord; inserted: boolean }> {
    const dedupeKey = event.dedupeKey ? `${event.userId}:${event.dedupeKey}` : undefined;
    if (dedupeKey) {
      const existingId = this.eventIdsByDedupeKey.get(dedupeKey);
      const existing = existingId ? this.events.get(existingId) : undefined;
      if (existing) return { event: existing, inserted: false };
      this.eventIdsByDedupeKey.set(dedupeKey, event.id);
    }
    const existing = this.events.get(event.id);
    if (existing) return { event: existing, inserted: false };
    this.events.set(event.id, cloneEvent(event));
    return { event: cloneEvent(event), inserted: true };
  }

  public async getPreferenceByIdentity(userId: string, identityKey: string): Promise<UserPreference | null> {
    const item = this.preferences.get(`${userId}:${identityKey}`);
    return item ? clonePreference(item) : null;
  }

  public async upsertPreference(preference: UserPreference): Promise<UserPreference> {
    this.preferences.set(`${preference.userId}:${preference.identityKey}`, clonePreference(preference));
    return clonePreference(preference);
  }

  public async listPreferences(userId: string, options: PreferenceListOptions = {}): Promise<UserPreference[]> {
    const statuses = options.statuses ? new Set(options.statuses) : undefined;
    return Array.from(this.preferences.values())
      .filter((item) => item.userId === userId && (!statuses || statuses.has(item.status)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, options.limit ?? 500)
      .map(clonePreference);
  }

  public async touchPreferences(userId: string, preferenceIds: string[], usedAt: string): Promise<number> {
    const ids = new Set(preferenceIds);
    let count = 0;
    for (const [key, item] of this.preferences.entries()) {
      if (item.userId !== userId || !ids.has(item.id)) continue;
      this.preferences.set(key, { ...item, lastUsedAt: usedAt, updatedAt: usedAt });
      count += 1;
    }
    return count;
  }
}

function cloneEvent(event: PreferenceEventRecord): PreferenceEventRecord {
  return { ...event, payload: { ...event.payload } };
}

function clonePreference(preference: UserPreference): UserPreference {
  return {
    ...preference,
    scope: { ...preference.scope },
    sourceTypes: [...preference.sourceTypes],
    evidenceEventIds: [...preference.evidenceEventIds],
    metadata: { ...preference.metadata },
  };
}
