import type { StorageGateway, StorageConfig, UploadUrl } from './types';

/**
 * S3 storage implementation for deployed environments
 * Uses Cognito for authentication and presigned URLs for uploads
 */
export class S3Storage implements StorageGateway {
  private config: StorageConfig;
  private credentials: AWSCredentials | null = null;
  private credentialsExpiry: number = 0;

  constructor(config: StorageConfig) {
    this.config = config;
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

  async writeBytes(path: string, data: ArrayBuffer, contentType?: string): Promise<void> {
    const { url, method, headers } = await this.getUploadUrl(path, contentType || 'application/octet-stream');

    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`Failed to write ${path}: ${response.status}`);
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    await this.writeBytes(path, data.buffer as ArrayBuffer, 'text/plain');
  }

  async list(prefix: string): Promise<string[]> {
    const credentials = await this.getCredentials();
    const url = `https://s3.${this.config.region}.amazonaws.com/${this.config.bucket}?list-type=2&prefix=${this.config.basePath}/${prefix}`;

    const response = await this.signedFetch(url, 'GET', credentials);
    if (!response.ok) {
      throw new Error(`Failed to list ${prefix}: ${response.status}`);
    }

    const xml = await response.text();
    return this.parseS3ListResponse(xml);
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
    const credentials = await this.getCredentials();
    const url = `https://s3.${this.config.region}.amazonaws.com/${this.config.bucket}/${this.config.basePath}/${path}`;

    const response = await this.signedFetch(url, 'DELETE', credentials);
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete ${path}: ${response.status}`);
    }
  }

  async getUploadUrl(path: string, contentType: string): Promise<UploadUrl> {
    const credentials = await this.getCredentials();
    const fullPath = `${this.config.basePath}/${path}`;

    // Generate presigned URL for PUT
    const url = await this.generatePresignedUrl(
      'PUT',
      this.config.bucket!,
      fullPath,
      contentType,
      credentials
    );

    return {
      url,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
    };
  }

  getReadUrl(path: string): string {
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${this.config.basePath}/${path}`;
  }

  // --- Private helpers ---

  private async getCredentials(): Promise<AWSCredentials> {
    // Check if we have valid cached credentials
    if (this.credentials && Date.now() < this.credentialsExpiry - 60000) {
      return this.credentials;
    }

    // Get credentials from Cognito Identity Pool
    // This is a simplified version - in production, use AWS SDK
    const identityResponse = await fetch(
      `https://cognito-identity.${this.config.region}.amazonaws.com/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityService.GetId',
        },
        body: JSON.stringify({
          IdentityPoolId: this.config.identityPoolId,
        }),
      }
    );

    if (!identityResponse.ok) {
      throw new Error('Failed to get Cognito identity');
    }

    const { IdentityId } = await identityResponse.json();

    const credentialsResponse = await fetch(
      `https://cognito-identity.${this.config.region}.amazonaws.com/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
        },
        body: JSON.stringify({
          IdentityId,
        }),
      }
    );

    if (!credentialsResponse.ok) {
      throw new Error('Failed to get Cognito credentials');
    }

    const { Credentials } = await credentialsResponse.json();

    this.credentials = {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretKey,
      sessionToken: Credentials.SessionToken,
    };
    this.credentialsExpiry = new Date(Credentials.Expiration).getTime();

    return this.credentials;
  }

  private async signedFetch(
    url: string,
    method: string,
    credentials: AWSCredentials
  ): Promise<Response> {
    // Simplified AWS Signature V4 signing
    // In production, use AWS SDK or a proper signing library
    const headers: Record<string, string> = {
      'x-amz-security-token': credentials.sessionToken,
    };

    return fetch(url, { method, headers });
  }

  private async generatePresignedUrl(
    _method: string,
    bucket: string,
    key: string,
    _contentType: string,
    credentials: AWSCredentials
  ): Promise<string> {
    // Simplified presigned URL generation
    // In production, use AWS SDK
    const expiration = 900; // 15 minutes
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = timestamp.slice(0, 8);

    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${credentials.accessKeyId}/${date}/${this.config.region}/s3/aws4_request`,
      'X-Amz-Date': timestamp,
      'X-Amz-Expires': String(expiration),
      'X-Amz-SignedHeaders': 'content-type;host',
      'X-Amz-Security-Token': credentials.sessionToken,
    });

    // Note: This is a placeholder. Real implementation needs proper signature calculation
    return `https://s3.${this.config.region}.amazonaws.com/${bucket}/${key}?${params}`;
  }

  private parseS3ListResponse(xml: string): string[] {
    // Simple XML parsing for S3 list response
    const keys: string[] = [];
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match;

    while ((match = keyRegex.exec(xml)) !== null) {
      const key = match[1];
      // Remove base path prefix
      const prefixToRemove = `${this.config.basePath}/`;
      keys.push(key.startsWith(prefixToRemove) ? key.slice(prefixToRemove.length) : key);
    }

    return keys;
  }
}

interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}
