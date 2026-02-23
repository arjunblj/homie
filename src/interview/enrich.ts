import { sanitizeExternalContent } from '../security/contentSanitizer.js';

export interface EnrichmentContext {
  worldview: string;
  communicationStyle: string;
  culturalGrounding: string;
  domainExpertise: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface BraveWebResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

const braveSearch = async (query: string, apiKey: string, count = 3): Promise<SearchResult[]> => {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as BraveWebResponse;
    return (data.web?.results ?? []).map((r) => ({
      title: sanitizeExternalContent(r.title ?? '', { maxLength: 200 }).sanitizedText,
      url: r.url ?? '',
      snippet: sanitizeExternalContent(r.description ?? '', { maxLength: 400 }).sanitizedText,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

const formatResults = (results: SearchResult[]): string =>
  results
    .filter((r) => r.snippet)
    .map((r) => `- ${r.title} (${r.url}): ${r.snippet}`)
    .join('\n')
    .slice(0, 1500);

export interface EnrichmentQuery {
  category: keyof EnrichmentContext;
  query: string;
}

export const buildEnrichmentQueries = (params: {
  friendName: string;
  transcript: string;
  operatorContext?: string | undefined;
}): EnrichmentQuery[] => {
  const text = `${params.transcript}\n${params.operatorContext ?? ''}`.toLowerCase();
  const queries: EnrichmentQuery[] = [];

  const philosophies = [
    'stoicism',
    'absurdism',
    'existentialism',
    'nihilism',
    'pragmatism',
    'utilitarianism',
    'virtue ethics',
    'taoism',
    'buddhism',
    'epicureanism',
  ];
  const matchedPhilosophy = philosophies.find((p) => text.includes(p));
  if (matchedPhilosophy) {
    queries.push({
      category: 'worldview',
      query: `${matchedPhilosophy} core ideas quotes practical application`,
    });
  }

  const worldviewSignals = text.match(
    /\b(cynical|optimistic|skeptic|romantic|pragmatic|idealist|realist)\b/gu,
  );
  if (worldviewSignals?.length) {
    queries.push({
      category: 'worldview',
      query: `${worldviewSignals[0]} worldview philosophy thinkers`,
    });
  }

  const styleSignals = text.match(
    /\b(sardonic|dry humor|deadpan|sarcastic|witty|blunt|warm|gentle)\b/gu,
  );
  if (styleSignals?.length) {
    queries.push({
      category: 'communicationStyle',
      query: `${styleSignals[0]} communication style writing voice examples`,
    });
  }

  const subcultures = [
    'indie games',
    'hacker culture',
    'punk',
    'cottagecore',
    'solarpunk',
    'vaporwave',
    'dark academia',
    'goblincore',
    'street art',
  ];
  const matchedSubculture = subcultures.find((s) => text.includes(s));
  if (matchedSubculture) {
    queries.push({
      category: 'culturalGrounding',
      query: `${matchedSubculture} culture vocabulary aesthetic references`,
    });
  }

  const domains = text.match(
    /\b(cooking|urban planning|ai ethics|machine learning|philosophy|systems thinking|music production|architecture|biology|physics|psychology)\b/gu,
  );
  if (domains?.length) {
    const uniqueDomains = [...new Set(domains)].slice(0, 2);
    for (const domain of uniqueDomains) {
      queries.push({
        category: 'domainExpertise',
        query: `${domain} terminology key concepts vocabulary`,
      });
    }
  }

  return queries.slice(0, 6);
};

export const runEnrichmentSearches = async (
  queries: EnrichmentQuery[],
  apiKey: string,
  onProgress?: (msg: string) => void,
): Promise<EnrichmentContext> => {
  const context: EnrichmentContext = {
    worldview: '',
    communicationStyle: '',
    culturalGrounding: '',
    domainExpertise: '',
  };

  if (!queries.length) return context;

  onProgress?.(`researching ${queries.length} dimensions for richer identity...`);

  const results = await Promise.allSettled(
    queries.map(async (q) => {
      const searchResults = await braveSearch(q.query, apiKey);
      return { category: q.category, results: searchResults, query: q.query };
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value.results.length) continue;
    const { category, results: searchResults } = r.value;
    const formatted = formatResults(searchResults);
    if (!formatted) continue;
    context[category] = context[category] ? `${context[category]}\n${formatted}` : formatted;
  }

  const enrichedCount = Object.values(context).filter(Boolean).length;
  if (enrichedCount > 0) {
    onProgress?.(`found grounding material across ${enrichedCount} dimensions`);
  }

  return context;
};

export const formatEnrichmentForPrompt = (context: EnrichmentContext): string => {
  const sections: string[] = [];

  if (context.worldview) {
    sections.push(`<worldview_research>\n${context.worldview}\n</worldview_research>`);
  }
  if (context.communicationStyle) {
    sections.push(
      `<communication_style_research>\n${context.communicationStyle}\n</communication_style_research>`,
    );
  }
  if (context.culturalGrounding) {
    sections.push(
      `<cultural_grounding_research>\n${context.culturalGrounding}\n</cultural_grounding_research>`,
    );
  }
  if (context.domainExpertise) {
    sections.push(
      `<domain_expertise_research>\n${context.domainExpertise}\n</domain_expertise_research>`,
    );
  }

  if (!sections.length) return '';

  return [
    '',
    'WebResearchContext (use these real-world references to ground the identity — weave in specific vocabulary, ideas, and cultural touchpoints rather than generic descriptions):',
    ...sections,
  ].join('\n');
};
