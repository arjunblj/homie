export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      HOMIE_OLLAMA_URL?: string | undefined;
      HOMIE_OLLAMA_VISION_MODEL?: string | undefined;
      HOMIE_WHISPER_MODEL?: string | undefined;
      HOMIE_WHISPER_CLI?: string | undefined;
    }
  }
}
