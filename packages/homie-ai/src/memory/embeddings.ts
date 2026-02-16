import { type EmbeddingModel, embed, embedMany } from 'ai';

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export function createEmbedder(model: EmbeddingModel): Embedder {
  return {
    async embed(text: string): Promise<Float32Array> {
      const { embedding } = await embed({ model, value: text });
      return new Float32Array(embedding);
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings.map((e) => new Float32Array(e));
    },
  };
}
