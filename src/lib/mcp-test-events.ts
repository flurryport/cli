import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Provider-shaped test webhook templates for `send_test_event` (0.2.2, agent feedback).
 * Each template produces a body + headers that light up the server's provider detection
 * (see Core.Logic ProviderInference: signature header → hint; body `type` / topic
 * headers → event type). Signature values are SHAPE-realistic placeholders only — they
 * will NOT pass real provider signature verification, and the tool description says so.
 */

export type TestProvider = 'stripe' | 'github' | 'shopify' | 'slack' | 'twilio';

export interface TestEvent {
  /** The provider-visible synthetic event id (also returned in deliveries[]). */
  syntheticEventId: string;
  /** Correlation id sent as the x-flurryport-test-id header. */
  testId: string;
  headers: Record<string, string>;
  body: string;
}

export const DEFAULT_EVENT_TYPES: Record<TestProvider, string> = {
  stripe: 'payment_intent.succeeded',
  github: 'push',
  shopify: 'orders/create',
  slack: 'event_callback',
  twilio: 'message.received',
};

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const b64 = (bytes: number) => randomBytes(bytes).toString('base64');

/** Deep-merge overrides into a template (objects merge, everything else replaces). */
export function mergeOverrides(base: Record<string, unknown>, overrides?: Record<string, unknown>): Record<string, unknown> {
  if (!overrides) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = out[key];
    if (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      out[key] = mergeOverrides(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface TestDelivery {
  index: number;
  syntheticEventId: string;
  testId: string;
  statusCode: number;
  sentAt: string;
}

export interface BatchResult {
  deliveries: TestDelivery[];
  paced: boolean;
  totalWaitMs: number;
}

/**
 * Shared send loop for anon + authed send_test_event. Tracks the burst window locally
 * between sends (the server stays authoritative); with pace auto it waits out the
 * window inside the call, and retries a 429 once after the reset in case the local
 * estimate drifted (another sender sharing the window).
 */
export async function sendTestEventBatch(opts: {
  captureUrl: string;
  provider: TestProvider;
  eventType?: string;
  bodyOverrides?: Record<string, unknown>;
  requested: number;
  paceMode: 'auto' | 'none';
  burst: { limit: number; remaining: number; resetsInSeconds: number } | null;
}): Promise<BatchResult> {
  const deliveries: TestDelivery[] = [];
  let totalWaitMs = 0;
  let paced = false;
  let burstBudget = opts.burst ? opts.burst.remaining : Number.POSITIVE_INFINITY;
  let resetsInSeconds = opts.burst?.resetsInSeconds ?? 60;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitOutWindow = async () => {
    const waitMs = Math.min(Math.max(resetsInSeconds, 1), 65) * 1000;
    await sleep(waitMs);
    totalWaitMs += waitMs;
    paced = true;
    burstBudget = opts.burst?.limit ?? Number.POSITIVE_INFINITY;
    resetsInSeconds = 60;
  };
  const post = async (headers: Record<string, string>, body: string): Promise<number> => {
    try {
      const res = await fetch(opts.captureUrl, { method: 'POST', headers, body });
      await res.text().catch(() => {});
      return res.status;
    } catch {
      return 0;
    }
  };

  for (let i = 0; i < opts.requested; i++) {
    if (burstBudget <= 0 && opts.paceMode === 'auto') await waitOutWindow();
    const evt = buildTestEvent(opts.provider, opts.eventType, opts.bodyOverrides, i + 1);
    const sentAt = new Date().toISOString();
    let statusCode = await post(evt.headers, evt.body);
    burstBudget--;
    if (statusCode === 429 && opts.paceMode === 'auto') {
      await waitOutWindow();
      statusCode = await post(evt.headers, evt.body);
      burstBudget--;
    }
    deliveries.push({ index: i + 1, syntheticEventId: evt.syntheticEventId, testId: evt.testId, statusCode, sentAt });
    if (statusCode === 429 && opts.paceMode === 'none') break;
  }

  return { deliveries, paced, totalWaitMs };
}

export function buildTestEvent(
  provider: TestProvider,
  eventType: string | undefined,
  bodyOverrides: Record<string, unknown> | undefined,
  sequence: number,
): TestEvent {
  const type = eventType ?? DEFAULT_EVENT_TYPES[provider];
  const testId = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const shared = { 'x-flurryport-test-id': testId };

  switch (provider) {
    case 'stripe': {
      const syntheticEventId = `evt_test_${hex(12)}`;
      const body = mergeOverrides(
        {
          id: syntheticEventId,
          object: 'event',
          api_version: '2024-06-20',
          created: nowSeconds,
          livemode: false,
          pending_webhooks: 1,
          request: { id: `req_${hex(12)}`, idempotency_key: `ik_test_${sequence}` },
          type,
          data: {
            object: {
              id: `pi_${hex(12)}`,
              object: 'payment_intent',
              amount: 1999,
              currency: 'usd',
              status: 'succeeded',
              metadata: { source: 'flurryport_send_test_event', sequence },
            },
          },
        },
        bodyOverrides,
      );
      return {
        syntheticEventId,
        testId,
        headers: {
          ...shared,
          'Content-Type': 'application/json',
          'Stripe-Signature': `t=${nowSeconds},v1=${hex(32)},v0=${hex(32)}`,
          'User-Agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
        },
        body: JSON.stringify(body),
      };
    }
    case 'github': {
      const syntheticEventId = randomUUID();
      const sha = hex(20);
      const body = mergeOverrides(
        {
          ref: 'refs/heads/main',
          before: hex(20),
          after: sha,
          repository: { full_name: 'example/repo', private: false, default_branch: 'main' },
          pusher: { name: 'octocat', email: 'octocat@example.com' },
          head_commit: {
            id: sha,
            message: `flurryport test event ${sequence}`,
            timestamp: new Date().toISOString(),
            author: { name: 'octocat', email: 'octocat@example.com' },
          },
        },
        bodyOverrides,
      );
      return {
        syntheticEventId,
        testId,
        headers: {
          ...shared,
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': `sha256=${hex(32)}`,
          'X-GitHub-Event': type,
          'X-GitHub-Delivery': syntheticEventId,
          'User-Agent': 'GitHub-Hookshot/0000000',
        },
        body: JSON.stringify(body),
      };
    }
    case 'shopify': {
      const orderId = 5_000_000_000 + sequence;
      const syntheticEventId = String(orderId);
      const body = mergeOverrides(
        {
          id: orderId,
          email: 'customer@example.com',
          created_at: new Date().toISOString(),
          total_price: '42.00',
          currency: 'USD',
          financial_status: 'paid',
          line_items: [{ id: orderId + 1, title: 'Test product', quantity: 1, price: '42.00' }],
        },
        bodyOverrides,
      );
      return {
        syntheticEventId,
        testId,
        headers: {
          ...shared,
          'Content-Type': 'application/json',
          'X-Shopify-Hmac-Sha256': b64(32),
          'X-Shopify-Topic': type,
          'X-Shopify-Shop-Domain': 'example.myshopify.com',
          'X-Shopify-Webhook-Id': randomUUID(),
        },
        body: JSON.stringify(body),
      };
    }
    case 'slack': {
      const syntheticEventId = `Ev${hex(8).toUpperCase()}`;
      const body = mergeOverrides(
        {
          token: 'test_verification_token',
          team_id: 'T0000001',
          api_app_id: 'A0000001',
          type,
          event_id: syntheticEventId,
          event_time: nowSeconds,
          event: {
            type: 'message',
            channel: 'C0000001',
            user: 'U0000001',
            text: `flurryport test event ${sequence}`,
            ts: `${nowSeconds}.0001`,
          },
        },
        bodyOverrides,
      );
      return {
        syntheticEventId,
        testId,
        headers: {
          ...shared,
          'Content-Type': 'application/json',
          'X-Slack-Signature': `v0=${hex(32)}`,
          'X-Slack-Request-Timestamp': String(nowSeconds),
        },
        body: JSON.stringify(body),
      };
    }
    case 'twilio': {
      // Twilio delivers form-encoded, not JSON; bodyOverrides merge into the form fields.
      const syntheticEventId = `SM${hex(16)}`;
      const fields = mergeOverrides(
        {
          MessageSid: syntheticEventId,
          AccountSid: `AC${hex(16)}`,
          From: '+15005550006',
          To: '+15005550009',
          Body: `flurryport test event ${sequence}`,
          NumMedia: '0',
        },
        bodyOverrides,
      );
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
      return {
        syntheticEventId,
        testId,
        headers: {
          ...shared,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': b64(20),
          'User-Agent': 'TwilioProxy/1.1',
        },
        body: form.toString(),
      };
    }
  }
}
