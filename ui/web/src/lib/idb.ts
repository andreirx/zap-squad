/**
 * IndexedDB persistence layer for ZapSquad.
 *
 * Shared database ("zapsquad") with five object stores:
 * - assets: user-created tile/character/weapon blobs + metadata
 * - levels: LDtk JSON levels (from MapEditor)
 * - worlds: freedom-board world state (sparse tiles + characters + camera)
 * - config: application preferences and state
 * - files: raw file storage for editor persistence (path-keyed, replaces StorageGateway writes)
 *
 * IndexedDB was chosen over localStorage because:
 * - Accessible from Web Workers (where WASM runs)
 * - 50MB+ storage limit vs localStorage's 5MB
 * - Supports ArrayBuffer natively (no base64 overhead for PNGs)
 * - Transactional guarantees
 *
 * All stores use out-of-line keys (key passed to put/get, not embedded in value).
 * This keeps values clean and allows key enumeration via getAllKeys().
 *
 * See docs/DECISIONS.md ADR for full architectural rationale.
 */

const DB_NAME = 'zapsquad';
const DB_VERSION = 3;

const STORE_ASSETS = 'assets';
const STORE_LEVELS = 'levels';
const STORE_WORLDS = 'worlds';
const STORE_CONFIG = 'config';
const STORE_FILES = 'files';
const STORE_GAME_DEFS = 'game_defs';

// ── Database lifecycle ──────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open (or reuse) the shared IDB database.
 *
 * The database is created/upgraded on first open. Subsequent calls reuse
 * the same connection. If the connection is closed (e.g., by the browser
 * during storage pressure), the next call reopens it.
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      // Sequential migration chain. Each case falls through to the next.
      // A fresh database has oldVersion=0 and runs ALL migrations.
      // An existing database runs only the migrations it hasn't seen.
      //
      // To add a new migration:
      //   1. Bump DB_VERSION
      //   2. Add a new case at the end (before the closing brace)
      //   3. Log what changed
      //
      // Rules:
      //   - Never modify an existing case. Append only.
      //   - Each case must be idempotent (safe to re-run if browser crashes mid-upgrade).
      //   - Use createObjectStore/deleteObjectStore for schema changes.
      //   - For data migrations, use the transaction from event.target.transaction.

      if (oldVersion < 1) {
        // v1: initial schema — four core stores
        db.createObjectStore(STORE_ASSETS);
        db.createObjectStore(STORE_LEVELS);
        db.createObjectStore(STORE_WORLDS);
        db.createObjectStore(STORE_CONFIG);
        console.log('[idb] migration v0→v1: created assets, levels, worlds, config stores');
      }

      if (oldVersion < 2) {
        // v2: raw file storage for editor persistence (replaces StorageGateway writes)
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES);
        }
        console.log('[idb] migration v1→v2: created files store');
      }

      if (oldVersion < 3) {
        // v3: game definitions store for the rules editor
        if (!db.objectStoreNames.contains(STORE_GAME_DEFS)) {
          db.createObjectStore(STORE_GAME_DEFS);
        }
        console.log('[idb] migration v2→v3: created game_defs store');
      }

      // Future migrations go here:
      // if (oldVersion < 3) { ... }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Reset promise if connection closes so next call reopens
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

// ── Generic CRUD operations ─────────────────────────────────────────

async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut<T>(storeName: string, key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbKeys(storeName: string): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAllKeys();
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}

async function idbGetAll<T>(storeName: string): Promise<Array<{ key: string; value: T }>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const results: Array<{ key: string; value: T }> = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        results.push({ key: cursor.key as string, value: cursor.value as T });
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// ── World store ─────────────────────────────────────────────────────

/** Serialized tile in a world save. Uses asset UUID, not runtime index. */
export interface WorldTile {
  x: number;
  y: number;
  uuid: string;
  variant: number;
  layer: number;
  flags: number;
}

/** Serialized character in a world save. */
export interface WorldCharacter {
  x: number;
  y: number;
  bodyDefId: string;
  direction: string;
  health: number;
  maxHealth: number;
}

/** Complete world state for persistence. */
export interface WorldData {
  version: number;
  tiles: WorldTile[];
  characters: WorldCharacter[];
  camera: { x: number; y: number; zoom: number };
  updatedAt: number;
}

export const worldStore = {
  save: (name: string, world: WorldData): Promise<void> =>
    idbPut(STORE_WORLDS, name, { ...world, updatedAt: Date.now() }),

  load: (name: string): Promise<WorldData | undefined> =>
    idbGet<WorldData>(STORE_WORLDS, name),

  delete: (name: string): Promise<void> =>
    idbDelete(STORE_WORLDS, name),

  list: (): Promise<string[]> =>
    idbKeys(STORE_WORLDS),

  /** Get all worlds with their metadata (for listing with details). */
  getAll: (): Promise<Array<{ key: string; value: WorldData }>> =>
    idbGetAll<WorldData>(STORE_WORLDS),

  /** Rename a world save (copy + delete). */
  rename: async (oldName: string, newName: string): Promise<void> => {
    const data = await idbGet<WorldData>(STORE_WORLDS, oldName);
    if (!data) throw new Error(`World "${oldName}" not found`);
    await idbPut(STORE_WORLDS, newName, data);
    await idbDelete(STORE_WORLDS, oldName);
  },
};

// ── Level store ─────────────────────────────────────────────────────

/** Stored level data. */
export interface LevelRecord {
  ldtk: unknown;
  updatedAt: number;
}

export const levelStore = {
  save: (name: string, ldtk: unknown): Promise<void> =>
    idbPut(STORE_LEVELS, name, { ldtk, updatedAt: Date.now() }),

  load: (name: string): Promise<LevelRecord | undefined> =>
    idbGet<LevelRecord>(STORE_LEVELS, name),

  delete: (name: string): Promise<void> =>
    idbDelete(STORE_LEVELS, name),

  list: (): Promise<string[]> =>
    idbKeys(STORE_LEVELS),
};

// ── Asset store ─────────────────────────────────────────────────────

/** Stored user-created asset. */
export interface AssetRecord {
  type: 'tile' | 'character' | 'weapon';
  source: 'seed' | 'user';
  metadata: Record<string, unknown>;
  blob: ArrayBuffer | null;
  updatedAt: number;
}

export const assetStore = {
  save: (uuid: string, asset: Omit<AssetRecord, 'updatedAt'>): Promise<void> =>
    idbPut(STORE_ASSETS, uuid, { ...asset, updatedAt: Date.now() }),

  load: (uuid: string): Promise<AssetRecord | undefined> =>
    idbGet<AssetRecord>(STORE_ASSETS, uuid),

  delete: (uuid: string): Promise<void> =>
    idbDelete(STORE_ASSETS, uuid),

  list: (): Promise<string[]> =>
    idbKeys(STORE_ASSETS),

  getAll: (): Promise<Array<{ key: string; value: AssetRecord }>> =>
    idbGetAll<AssetRecord>(STORE_ASSETS),
};

// ── Config store ────────────────────────────────────────────────────

export const configStore = {
  set: <T>(key: string, value: T): Promise<void> =>
    idbPut(STORE_CONFIG, key, value),

  get: <T>(key: string): Promise<T | undefined> =>
    idbGet<T>(STORE_CONFIG, key),

  delete: (key: string): Promise<void> =>
    idbDelete(STORE_CONFIG, key),
};

// ── Game definition store ───────────────────────────────────────────

/** Stored game definition (output of the rules editor). */
export interface GameDefRecord {
  /** The full GameDefinition JSON (matches core/entities/game_rules/definition.rs). */
  definition: Record<string, unknown>;
  updatedAt: number;
}

export const gameDefStore = {
  save: (name: string, definition: Record<string, unknown>): Promise<void> =>
    idbPut<GameDefRecord>(STORE_GAME_DEFS, name, { definition, updatedAt: Date.now() }),

  load: (name: string): Promise<GameDefRecord | undefined> =>
    idbGet<GameDefRecord>(STORE_GAME_DEFS, name),

  delete: (name: string): Promise<void> =>
    idbDelete(STORE_GAME_DEFS, name),

  list: (): Promise<string[]> =>
    idbKeys(STORE_GAME_DEFS),

  getAll: (): Promise<Array<{ key: string; value: GameDefRecord }>> =>
    idbGetAll<GameDefRecord>(STORE_GAME_DEFS),
};

// ── File store ──────────────────────────────────────────────────────

/** Raw file record stored in IDB. Mirrors a filesystem entry. */
export interface FileRecord {
  data: ArrayBuffer;
  contentType: string;
  updatedAt: number;
}

export const fileStore = {
  save: (path: string, data: ArrayBuffer, contentType: string): Promise<void> =>
    idbPut<FileRecord>(STORE_FILES, path, { data, contentType, updatedAt: Date.now() }),

  load: (path: string): Promise<FileRecord | undefined> =>
    idbGet<FileRecord>(STORE_FILES, path),

  delete: (path: string): Promise<void> =>
    idbDelete(STORE_FILES, path),

  list: (): Promise<string[]> =>
    idbKeys(STORE_FILES),

  /** Check if a path exists without loading the data. */
  exists: async (path: string): Promise<boolean> => {
    const record = await idbGet<FileRecord>(STORE_FILES, path);
    return record !== undefined;
  },
};

// ── Persistence helpers ─────────────────────────────────────────────

/**
 * Request persistent storage from the browser.
 *
 * Without this, the browser may evict IndexedDB data under storage pressure
 * (especially Firefox). Chrome is more lenient but still not guaranteed.
 *
 * Returns true if storage is now persistent, false if the browser declined.
 * Call once at app startup. The browser may show a permission prompt.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage?.persist) {
    return navigator.storage.persist();
  }
  return false;
}

/**
 * Estimate current storage usage.
 * Returns { usage, quota } in bytes, or null if not available.
 */
export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }
  return null;
}
