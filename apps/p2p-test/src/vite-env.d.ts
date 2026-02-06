/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
