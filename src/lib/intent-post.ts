import { createHmac } from 'node:crypto';
import { guidToBase62 } from './base62.js';
import { contributorKeyRef, getCredential, signingKeyRef, type StoredCredential } from './keystore.js';

/**
 * The intent-delivery core, shared by the MCP `post_intent` tool and the
 * `flurryport post` CLI verb (pilot-1 ledger item 5: seats had to hand-roll stdio
 * JSON-RPC because posting was reachable only through the MCP surface). One signing
 * path, one receipt parser - the CLI and the tool cannot drift apart.
 */

/**
 * Which local key signs intents for this endpoint: the OWNER key
 * (set_endpoint_signing) first, then the invite-rail CONTRIBUTOR key
 * (flurryport join). Null when neither is stored.
 */
export function chooseIntentKey(endpointId: string): { keyRef: string; credential: StoredCredential } | null {
  const ownerRef = signingKeyRef(endpointId);
  const owner = getCredential(ownerRef);
  if (owner) return { keyRef: ownerRef, credential: owner };
  const contribRef = contributorKeyRef(endpointId);
  const contrib = getCredential(contribRef);
  if (contrib) return { keyRef: contribRef, credential: contrib };
  return null;
}

/**
 * What a re-linked proposal changes against the recap standing in its section (#360b).
 * Server-computed: the CLI never diffs, it only relays what the capture receipt said.
 * Counts are all zero and meaningless when oversize is true.
 */
export interface PostDiffSummary {
  section: string;
  linesAdded: number;
  linesRemoved: number;
  linesChanged: number;
  unchanged: boolean;
  oversize: boolean;
}

/**
 * Correlation receipt from the capture endpoint (Codex round-2 item 2): the post sends
 * X-Flurry-Receipt, and a round2-server or newer Core answers
 * { captureId, executions[{executionId, replayTargetId}], postDiff } (rows are enqueued
 * synchronously at capture time). Older servers answer an empty 200 body - tolerate
 * that by returning nulls so the receipt shape stays additive.
 */
export async function parseCaptureReceipt(res: Response): Promise<{
  captureId: string | null;
  executions: Array<{ executionId: string; targetId: string }> | null;
  postDiff: PostDiffSummary | null;
}> {
  try {
    const text = await res.text();
    if (!text) return { captureId: null, executions: null, postDiff: null };
    const parsed = JSON.parse(text) as {
      captureId?: string;
      executions?: Array<{ executionId?: string; replayTargetId?: string }>;
      postDiff?: PostDiffSummary | null;
    };
    return {
      captureId: parsed.captureId ? guidToBase62(parsed.captureId) : null,
      executions: Array.isArray(parsed.executions)
        ? parsed.executions
            .filter((e) => e.executionId && e.replayTargetId)
            .map((e) => ({ executionId: guidToBase62(e.executionId!), targetId: guidToBase62(e.replayTargetId!) }))
        : null,
      postDiff:
        parsed.postDiff && typeof parsed.postDiff === 'object' && typeof parsed.postDiff.section === 'string'
          ? parsed.postDiff
          : null,
    };
  } catch {
    return { captureId: null, executions: null, postDiff: null };
  }
}

export interface IntentDelivery {
  httpStatus: number;
  ok: boolean;
  durationMs: number;
  sizeBytes: number;
  /** Response body text on a non-OK answer (for error reporting); empty on success. */
  errorText: string;
  captureId: string | null;
  executions: Array<{ executionId: string; targetId: string }> | null;
  /** #360b: set only when this post was a re-linked proposal addressed to a section. */
  postDiff: PostDiffSummary | null;
}

/**
 * POST an intent to the public capture URL, HMAC-signing when a key is given.
 * Delivery mechanics only - callers own key selection, refusals, and receipts.
 */
export async function deliverIntent(opts: {
  baseUrl: string;
  projectId: string;
  endpointSlug: string;
  body: string;
  contentType?: string | null;
  /** When present, the body is HMAC-SHA256 signed and the hex digest rides headerName. */
  signingKey?: string | null;
  headerName?: string | null;
  /**
   * #358: extra request headers the caller wants on the wire. The hosted rooms
   * service sends its provenance marker and the public host it presents here;
   * the signature is computed over the body only, so these never touch it.
   */
  extraHeaders?: Record<string, string> | null;
}): Promise<IntentDelivery> {
  const bodyBytes = Buffer.from(opts.body, 'utf8');
  const headers: Record<string, string> = {
    ...(opts.extraHeaders ?? {}),
    'Content-Type': opts.contentType?.trim() || 'application/json',
    'X-Flurry-Receipt': '1',
  };
  if (opts.signingKey) {
    const signature = createHmac('sha256', opts.signingKey).update(bodyBytes).digest('hex');
    headers[opts.headerName || 'X-Flurry-Signature'] = signature;
  }

  const started = Date.now();
  const res = await fetch(`${opts.baseUrl}/api/v1/capture/${opts.projectId}/${opts.endpointSlug}`, {
    method: 'POST',
    headers,
    body: bodyBytes,
  });
  const durationMs = Date.now() - started;

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    return {
      httpStatus: res.status,
      ok: false,
      durationMs,
      sizeBytes: bodyBytes.length,
      errorText,
      captureId: null,
      executions: null,
      postDiff: null,
    };
  }

  const receipt = await parseCaptureReceipt(res);
  return {
    httpStatus: res.status,
    ok: true,
    durationMs,
    sizeBytes: bodyBytes.length,
    errorText: '',
    captureId: receipt.captureId,
    executions: receipt.executions,
    postDiff: receipt.postDiff,
  };
}
