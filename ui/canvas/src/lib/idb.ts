/**
 * IndexedDB persistence layer for ZapSquad.
 *
 * Shared database ("zapsquad") with four object stores:
 * - assets: user-created tile/character/weapon blobs + metadata
 * - levels: LDtk JSON levels (from MapEditor)
 * - worlds: freedom-board world state (sparse tiles + characters + camera)
 * - config: application preferences and state
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
const DB_VERSION = 1;

const STORE_ASSETS = 'assets';
const STORE_LEVELS = 'levels';
const STORE_WORLDS = 'worlds';
const STORE_CONFIG = 'config';

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

      // Create stores if they don't exist (idempotent across version bumps)
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS);
      }
      if (!db.objectStoreNames.contains(STORE_LEVELS)) {
        db.createObjectStore(STORE_LEVELS);
      }
      if (!db.objectStoreNames.contains(STORE_WORLDS)) {
        db.createObjectStore(STORE_WORLDS);
      }
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG);
      }
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
