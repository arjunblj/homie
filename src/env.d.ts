export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      OPENHOMIE_OLLAMA_URL?: string | undefined;
      OPENHOMIE_OLLAMA_VISION_MODEL?: string | undefined;
      OPENHOMIE_WHISPER_MODEL?: string | undefined;
      OPENHOMIE_WHISPER_CLI?: string | undefined;
    }
  }
}
