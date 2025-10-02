interface ImportMetaEnv {
  readonly VITE_API_KEY: string;
  // otras variables si las necesitas
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
