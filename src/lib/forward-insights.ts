import { currentEchoUrl } from './echo-server.js';

/**
 * Structured facts about a forward result (agent feedback, 0.2.3 "legible results"):
 * a receipt of what was delivered, a rules-based diagnosis when the local handler
 * misbehaved, and the previous attempt for the same capture so progress is visible.
 * Deliberately FACTS ONLY - the calling model renders the story ("affordances over
 * prose"); no explanation database lives here.
 */

export interface ForwardReceipt {
  /** True when the token's redact scope masked the forwarded body (signatures will not verify). */
  redacted?: boolean;
  provider: string | null;
  eventType: string | null;
  signatureHeaderPresent: boolean;
  bodyValidJson: boolean;
  /** Present for Stripe-shaped JSON bodies; raw facts, the agent formats them. */
  stripe?: { objectType: string | null; amountCents: number | null; currency: string | null; status: string | null };
}

export interface ForwardDiagnosis {
  code: 'path_mismatch' | 'signature_verification' | 'auth_required' | 'handler_error';
  likelyCause: string;
  suggestion: string;
}

export interface PreviousAttempt {
  statusCode: number;
  durationMs: number;
  at: string;
}

const SIGNATURE_HEADERS = [
  'stripe-signature', 'x-hub-signature-256', 'x-shopify-hmac-sha256', 'x-slack-signature', 'x-twilio-signature',
];

/** Per-process memory of the last forward per capture - powers the attempt diff. */
const lastAttempts = new Map<string, PreviousAttempt>();

function parseHeaderNames(headersJson: string): string[] {
  try {
    return Object.keys(JSON.parse(headersJson) as Record<string, unknown>).map((h) => h.toLowerCase());
  } catch {
    return [];
  }
}

function tryParseJson(bodyText: string): unknown | undefined {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}

export function buildReceipt(capture: {
  provider: string | null;
  eventType: string | null;
  headersJson: string;
  bodyText: string;
}): ForwardReceipt {
  const headerNames = parseHeaderNames(capture.headersJson);
  const parsed = tryParseJson(capture.bodyText);
  const receipt: ForwardReceipt = {
    provider: capture.provider,
    eventType: capture.eventType,
    signatureHeaderPresent: SIGNATURE_HEADERS.some((h) => headerNames.includes(h)),
    bodyValidJson: parsed !== undefined,
  };

  if (capture.provider === 'stripe' && parsed && typeof parsed === 'object') {
    const root = parsed as { type?: unknown; data?: { object?: Record<string, unknown> } };
    const obj = root.data?.object ?? {};
    receipt.eventType = receipt.eventType ?? (typeof root.type === 'string' ? root.type : null);
    receipt.stripe = {
      objectType: typeof obj.object === 'string' ? obj.object : null,
      amountCents: typeof obj.amount === 'number' ? obj.amount : null,
      currency: typeof obj.currency === 'string' ? obj.currency : null,
      status: typeof obj.status === 'string' ? obj.status : null,
    };
  }
  return receipt;
}

export function diagnoseForward(opts: {
  statusCode: number;
  responseBodyPreview: string;
  provider: string | null;
  postedUrl: string;
}): ForwardDiagnosis | null {
  const { statusCode, responseBodyPreview, provider, postedUrl } = opts;
  if (statusCode >= 200 && statusCode < 300) return null;

  let path = '/';
  try {
    path = new URL(postedUrl).pathname;
  } catch {
    /* keep '/' */
  }

  if (statusCode === 404) {
    return {
      code: 'path_mismatch',
      likelyCause: `The local app answered 404 for ${path}.`,
      suggestion:
        `The webhook route probably lives on a different path (for example /api/webhooks/${provider ?? 'provider'}). ` +
        'Ask the user for the exact handler path and forward again with it.',
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      code: 'auth_required',
      likelyCause: `The local app rejected the request with ${statusCode}.`,
      suggestion:
        'The handler route appears to require authentication. Webhook endpoints usually skip session auth and rely ' +
        'on provider signature verification instead; check middleware ordering with the user.',
    };
  }
  if ((statusCode === 400 || statusCode >= 500) && provider && /signat/i.test(responseBodyPreview)) {
    return {
      code: 'signature_verification',
      likelyCause: 'The handler rejected the payload during signature verification.',
      suggestion:
        'Verify the app reads the RAW request body before any JSON body parser runs - framework parsers consume the ' +
        'raw bytes and break provider signatures. Note that send_test_event signatures are placeholders and always ' +
        'fail real verification; use a real provider event to test signature checks.',
    };
  }
  return {
    code: 'handler_error',
    likelyCause: `The local app answered ${statusCode}.`,
    suggestion: 'Inspect responseBodyPreview and the app logs; forward the same capture again after the fix to compare attempts.',
  };
}

/** Record this attempt and return the one it replaced (same capture, this process). */
export function swapAttempt(captureId: string, statusCode: number, durationMs: number): PreviousAttempt | null {
  const previous = lastAttempts.get(captureId) ?? null;
  lastAttempts.set(captureId, { statusCode, durationMs, at: new Date().toISOString() });
  return previous;
}

/** Next-step suggestion for a SUCCESSFUL forward: echo proves the loop, the real handler is the point. */
export function successNextAction(postedUrl: string, statusCode: number): string | null {
  if (statusCode < 200 || statusCode >= 300) return null;
  const echo = currentEchoUrl();
  if (echo && postedUrl.startsWith(echo.replace(/\/$/, ''))) {
    return 'The replay loop is proven against the echo server. Point the same capture at the user’s real handler next (ask for its port and path).';
  }
  return null;
}
