import { z } from 'zod';

export const ChatTrustTierSchema = z.enum(['untrusted', 'warming', 'trusted']);
export type ChatTrustTier = z.infer<typeof ChatTrustTierSchema>;
