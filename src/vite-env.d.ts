/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_TRIALS_CONTRACT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
