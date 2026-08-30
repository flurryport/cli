/**
 * Live plan/pricing catalog for the get_upgrade_options MCP tool (both modes).
 *
 * Pulls from the billing API's PUBLIC endpoints - /api/v1/billing/plans and
 * /api/v1/billing/day-passes - the same source of truth that powers the in-app
 * billing page and the marketing pricing widget. Nothing is hardcoded here, so
 * price or limit changes ship to every AI conversation the moment the server
 * seeds change. No auth required (both endpoints are anonymous).
 */

export interface PlanCatalogPlan {
  planTierId: number;
  name: string;
  displayName: string;
  description: string | null;
  monthlyPrice: string;
  monthlyPriceCents: number;
  /** null = yearly billing not offered for this tier. */
  yearlyPrice: string | null;
  yearlyPriceCents: number;
  limits: Record<string, string | number | boolean>;
}

export interface PlanCatalogDayPass {
  days: number;
  price: string;
  priceCents: number;
  grantsTier: string;
  planTierId: number;
}

export interface PlanCatalog {
  plans: PlanCatalogPlan[];
  dayPasses: PlanCatalogDayPass[];
  notes: string[];
}

interface RawPlan {
  PlanTierId: number;
  Name: string;
  DisplayName: string;
  Description?: string | null;
  PriceAmountCents: number;
  YearlyPriceAmountCents: number;
  MaxProjects: number;
  MaxEndpointsPerProject: number;
  MaxReplayTargetsPerProject: number;
  RetentionDays: number;
  MaxPayloadBytes: number;
  MaxAutoReplayTargets: number;
  MaxLocalAutoReplayTargets: number;
  MaxCollections: number;
  MaxCollectionItems: number;
  FullResponseBody: boolean;
  MaxMonthlyCaptures: number;
  MaxBurstPerMinute: number;
  SortOrder: number;
}

interface RawDayPass {
  Days: number;
  AmountCents: number;
  PlanTierId: number;
}

/**
 * FLURRYPORT_BILLING_URL wins (local stacks run billing on its own port);
 * otherwise the caller's API base (prod ingress routes /api/v1/billing there);
 * otherwise production.
 */
export function resolveBillingBaseUrl(fallbackApiUrl?: string): string {
  return (process.env.FLURRYPORT_BILLING_URL ?? fallbackApiUrl ?? 'https://api.flurryport.io')
    .replace(/\/$/, '');
}

function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function limit(value: number, suffix = ''): string | number {
  return value === -1 ? 'unlimited' : suffix ? `${value}${suffix}` : value;
}

function shapePlan(p: RawPlan): PlanCatalogPlan {
  const custom = p.PriceAmountCents === -1;
  return {
    planTierId: p.PlanTierId,
    name: p.Name,
    displayName: p.DisplayName,
    description: p.Description ?? null,
    monthlyPrice: custom ? 'custom (contact sales)' : p.PriceAmountCents === 0 ? 'free' : `${dollars(p.PriceAmountCents)}/month`,
    monthlyPriceCents: p.PriceAmountCents,
    yearlyPrice:
      p.YearlyPriceAmountCents === 0 ? null
      : p.YearlyPriceAmountCents === -1 ? 'custom (contact sales)'
      : `${dollars(p.YearlyPriceAmountCents)}/year (2 months free vs monthly)`,
    yearlyPriceCents: p.YearlyPriceAmountCents,
    limits: {
      projects: limit(p.MaxProjects),
      endpointsPerProject: limit(p.MaxEndpointsPerProject),
      replayTargetsPerProject: limit(p.MaxReplayTargetsPerProject),
      // The split that matters to MCP users: local = CLI/MCP auto-forward to
      // their own machine; external = server-delivered auto-forward.
      localAutoForwardTargets: limit(p.MaxLocalAutoReplayTargets),
      externalAutoForwardTargets: limit(p.MaxAutoReplayTargets),
      retentionDays: limit(p.RetentionDays),
      monthlyCaptures: limit(p.MaxMonthlyCaptures),
      burstCapturesPerMinute: limit(p.MaxBurstPerMinute),
      maxPayloadBytes: limit(p.MaxPayloadBytes),
      collections: limit(p.MaxCollections),
      itemsPerCollection: limit(p.MaxCollectionItems),
      fullResponseBodies: p.FullResponseBody,
    },
  };
}

const CATALOG_TTL_MS = 5 * 60_000;
const cache = new Map<string, { catalog: PlanCatalog; fetchedAt: number }>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Fetches and shapes the catalog (5-min cache per base URL). Day passes are
 * best-effort: if that endpoint fails, plans still return with a note, so a
 * partial billing outage never blanks the whole sales surface.
 */
export async function fetchPlanCatalog(baseUrl: string): Promise<PlanCatalog> {
  const cached = cache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.catalog;

  const plansRes = await getJson<{ Items: RawPlan[] }>(`${baseUrl}/api/v1/billing/plans`);
  const plans = (plansRes.Items ?? [])
    .slice()
    .sort((a, b) => a.SortOrder - b.SortOrder)
    .map(shapePlan);

  const byTier = new Map(plans.map((p) => [p.planTierId, p]));
  let dayPasses: PlanCatalogDayPass[] = [];
  const notes = [
    "'unlimited' means no cap on that plan.",
    'Yearly pricing, where offered, is 10x monthly (2 months free).',
    'Day passes grant the listed tier for a fixed number of days with no subscription - good for a burst of debugging.',
    'Subscribing, changing plans, and buying day passes all happen in the web app; you cannot purchase on the user\'s behalf.',
  ];
  try {
    const passRes = await getJson<{ Items: RawDayPass[] }>(`${baseUrl}/api/v1/billing/day-passes`);
    dayPasses = (passRes.Items ?? []).map((d) => ({
      days: d.Days,
      price: dollars(d.AmountCents),
      priceCents: d.AmountCents,
      grantsTier: byTier.get(d.PlanTierId)?.displayName ?? `tier ${d.PlanTierId}`,
      planTierId: d.PlanTierId,
    }));
  } catch {
    notes.push('Day-pass catalog was unavailable just now; plans above are complete.');
  }

  const catalog: PlanCatalog = { plans, dayPasses, notes };
  cache.set(baseUrl, { catalog, fetchedAt: Date.now() });
  return catalog;
}
