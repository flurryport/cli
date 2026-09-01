/**
 * Anonymous catalog reads for the search_recipes / get_recipe MCP tools (Catalog B3.3).
 *
 * Talks to the Catalog domain's PUBLIC endpoints - /api/v1/catalog/recipes[...] - the
 * same rows that back the prerendered /recipes pages, so the agent surface and the SEO
 * surface can never disagree. No auth in either mode.
 *
 * FLURRYPORT_CATALOG_URL wins (local compose runs catalog-api on :8087); otherwise the
 * production API host (the ingress routes /api/v1/catalog to catalog-api ahead of the
 * core catch-all - B3.0b carve-out).
 */

import { parseErrorResponse } from './fetch-error.js';

export interface CatalogRecipeItem {
  Ref: string;
  PublisherSlug: string;
  Slug: string;
  Kind: string;
  DestServiceSlug?: string | null;
  SourceServiceSlug?: string | null;
  ListingSummary?: string | null;
  /** #355: the version "latest" resolves to today, so a caller can form the exact pin
   *  {Ref}@{LatestVersion} without a second round trip. Absent on older servers. */
  LatestVersion?: number | null;
  /** #355: when LatestVersion was published. */
  PublishedAt?: string | null;
}

export interface CatalogRecipe {
  Ref: string;
  Kind: string;
  DestServiceSlug?: string | null;
  SourceServiceSlug?: string | null;
  ListingSummary?: string | null;
  Version: number;
  ContentHash: string;
  ContentJson: string;
  PublishedAt?: string | null;
  /** Build 2: server-inferred token need ("write"/"read"); optional for older servers. */
  TokenKind?: string | null;
  /** Slice 10d: true when the signed content carries a docs body — present even when
   *  ContentJson was served docs-stripped, so callers know the includeDocs opt-in exists. */
  HasDocs?: boolean;
  /** #355: the version latest resolves to right now. Equal to Version on an unpinned
   *  read; higher than Version means this response is an older pin. */
  LatestVersion?: number | null;
  /** #355 (publisher rules 5.1): the resolved version was yanked. Only an exact pin can
   *  land on one — latest resolution never does. */
  Yanked?: boolean;
  /** The publisher's yank reason, when Yanked. */
  YankedReason?: string | null;
}

export class CatalogApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * #355: the ProblemDetails sentence the catalog wrote, when it wrote one. Kept
     * apart from `message` so a caller can tell an explained refusal ("version 9 is not
     * published; the latest is 5") from the generic transport line.
     */
    public readonly detail: string | null = null,
    /** Machine error code from the shared ProblemDetails parse (review finding 10). */
    public readonly code: string = 'error',
  ) {
    super(message);
  }
}

export function resolveCatalogBaseUrl(): string {
  return (process.env.FLURRYPORT_CATALOG_URL ?? 'https://api.flurryport.io').replace(/\/$/, '');
}

/**
 * Tokenized any-match ranking for search_recipes (run-4 finding #1 / lesson 46
 * candidate: agents query in keyword sentences; the old whole-string substring
 * match answered [] to any natural multi-word query). Splits the query on
 * non-alphanumerics, keeps tokens of 2+ chars, scores each recipe by how many
 * tokens its searchable text contains, and returns matches ranked best-first.
 * A whole-phrase hit outranks every token count so exact lookups stay exact.
 * The catalog is small (tens of rows), so we rank rather than reject: one
 * generic token ("webhook") may match several recipes, but the best fit sorts
 * first and the agent reads summaries. Zero matched tokens = excluded.
 */
export function rankRecipesByQuery(items: CatalogRecipeItem[], query: string): CatalogRecipeItem[] {
  const phrase = query.trim().toLowerCase();
  const tokens = phrase.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (!tokens.length) return items;
  return items
    .map((r, index) => {
      const hay = [r.Ref, r.ListingSummary, r.DestServiceSlug, r.SourceServiceSlug, r.Kind]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const hits = tokens.filter((t) => hay.includes(t)).length;
      return { r, index, score: hay.includes(phrase) ? tokens.length + 1 : hits };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.r);
}

const LIST_TTL_MS = 5 * 60_000;
let listCache: { items: CatalogRecipeItem[]; fetchedAt: number } | null = null;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    // #355: a bad pin answers ProblemDetails whose detail NAMES the latest published
    // version. The SHARED parse (review finding 10 - this was the sixth hand-rolled
    // copy) keeps that sentence, the machine code, and any field errors. Only a
    // JSON body counts as the server's sentence (round 3): an ingress 502's raw
    // HTML page must fall back to the clean status line, not become the message.
    const { code, detail, isJson } = await parseErrorResponse(res);
    const sentence = isJson && detail.trim() ? detail : null;
    throw new CatalogApiError(res.status, sentence ?? `${res.status} ${res.statusText} from ${url}`, sentence, code);
  }
  return (await res.json()) as T;
}

/** Full published listing, cached briefly - the catalog is small and the tool may be
 * called repeatedly within one conversation. */
export async function listRecipes(): Promise<CatalogRecipeItem[]> {
  if (listCache && Date.now() - listCache.fetchedAt < LIST_TTL_MS) return listCache.items;
  const body = await getJson<{ Items: CatalogRecipeItem[] }>(`${resolveCatalogBaseUrl()}/api/v1/catalog/recipes`);
  listCache = { items: body.Items, fetchedAt: Date.now() };
  return body.Items;
}

/**
 * One recipe. `version` is the exact pin from a ref@N: it resolves that immutable
 * version with its own contentHash, and the response still reports LatestVersion so the
 * caller can see it is reading an older one. Omit it for the latest published version.
 * The pin rides as ?version=N, the query spelling of the slug@N path form.
 */
export async function getRecipe(
  publisher: string,
  slug: string,
  includeDocs = false,
  version?: number | null,
): Promise<CatalogRecipe> {
  const params = new URLSearchParams();
  if (includeDocs) params.set('includeDocs', 'true');
  if (typeof version === 'number') params.set('version', String(version));
  const qs = params.toString();
  return getJson<CatalogRecipe>(
    `${resolveCatalogBaseUrl()}/api/v1/catalog/recipes/${encodeURIComponent(publisher)}/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`,
  );
}

export interface CatalogLintFinding {
  Code: string;
  Severity: string; // "error" (publish refuses) | "warning" (install-success advice)
  Path: string;
  Message: string;
}

export interface CatalogLintResult {
  Ok: boolean;
  ErrorCount: number;
  WarningCount: number;
  Findings: CatalogLintFinding[];
}

/** Anonymous dry run of the publish gate's content checks (authoring-stack stage c). */
export async function lintRecipe(contentJson: string): Promise<CatalogLintResult> {
  const res = await fetch(`${resolveCatalogBaseUrl()}/api/v1/catalog/recipes/lint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ContentJson: contentJson }),
  });
  if (!res.ok) {
    throw new CatalogApiError(res.status, `${res.status} ${res.statusText} from the catalog lint endpoint`);
  }
  return (await res.json()) as CatalogLintResult;
}
