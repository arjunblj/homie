import { type EmbeddingModel, embed, embedMany } from 'ai';

export interface Embedder {
  readonly dims: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export function createEmbedder(model: EmbeddingModel, dims: number): Embedder {
  return {
    dims,
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
