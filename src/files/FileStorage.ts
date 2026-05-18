export type StoredFile = {
  storageProvider: "local" | "memory";
  storageKey: string;
};

export type FileStorage = {
  save(buffer: Buffer, originalName: string): Promise<StoredFile>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
};
