/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STORAGE_BASE_PATH?: string;
  readonly VITE_S3_BUCKET?: string;
  readonly VITE_AWS_REGION?: string;
  readonly VITE_COGNITO_IDENTITY_POOL_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
