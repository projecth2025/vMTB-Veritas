/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JITSI_BACKEND_URL: string
  readonly VITE_JITSI_DOMAIN: string
  readonly VITE_MAIN_APP_URL: string
  readonly VITE_DEBUG: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
