import type { StorageGateway, UploadUrl } from './types';

/**
 * Local storage implementation using Vite dev server
 * Uses the file-write plugin for writes and fetch for reads
 */
export class LocalStorage implements StorageGateway {
  private basePath: string;

  constructor(basePath: string = 'mods') {
    this.basePath = basePath;
  }

  async readText(path: string): Promise<string> {
    const url = this.getReadUrl(path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to read ${path}: ${response.status}`);
    }
    return response.text();
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    const url = this.getReadUrl(path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to read ${path}: ${response.status}`);
    }
    return response.arrayBuffer();
  }

  async writeBytes(path: string, data: ArrayBuffer, _contentType?: string): Promise<void> {
    const fullPath = `public/${this.basePath}/${path}`;
    const base64 = arrayBufferToBase64(data);

    const response = await fetch('/__write-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, content: base64 }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to write ${path}: ${error.error}`);
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    await this.writeBytes(path, data.buffer as ArrayBuffer, 'text/plain');
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = `public/${this.basePath}/${prefix}`;
    const response = await fetch(`/__list-files?prefix=${encodeURIComponent(fullPrefix)}`);

    if (!response.ok) {
      throw new Error(`Failed to list ${prefix}: ${response.status}`);
    }

    const { files } = await response.json();

    // Remove the public/mods/ prefix from paths
    const prefixToRemove = `public/${this.basePath}/`;
    return files.map((f: string) =>
      f.startsWith(prefixToRemove) ? f.slice(prefixToRemove.length) : f
    );
  }

  async exists(path: string): Promise<boolean> {
    const url = this.getReadUrl(path);
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async delete(path: string): Promise<void> {
    // Local storage doesn't support delete via the current plugin
    // For now, just log a warning
    console.warn(`LocalStorage.delete not implemented for: ${path}`);
  }

  async getUploadUrl(path: string, _contentType: string): Promise<UploadUrl> {
    // For local storage, we use the write endpoint directly
    // Return a fake URL that the caller should not actually use
    return {
      url: `/__write-file?path=${encodeURIComponent(path)}`,
      method: 'POST',
    };
  }

  getReadUrl(path: string): string {
    return `/${this.basePath}/${path}`;
  }
}

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
