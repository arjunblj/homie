export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      CI?: string;
      FC_RUNS?: string;
      FC_SEED?: string;
      UPDATE_GOLDEN?: string;
      OPENHOMIE_LOG_LEVEL?: string;
      BRAVE_API_KEY?: string;
    }
  }
}
