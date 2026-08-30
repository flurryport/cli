import { base62ToGuid, guidToBase62 } from './base62.js';
import { AuthApiError, type AuthApiClient } from './auth-api.js';
import { chooseIntentKey, deliverIntent, type IntentDelivery } from './intent-post.js';
import { generateSigningKey, putCredential, signingKeyRef } from './keystore.js';
import { consoleMessages as msg } from './console-messages.js';
import { mintSeatInvite } from './seat-mint.js';

/**
 * The console's room client: the OPERATOR's authed view of projects, endpoints,
 * seats, and the capture stream, plus the signed posting path. This is the
 * engine's only door to the API (the engine/render seam's other half: the engine
 * never fetches, the frontend never fetches - tests hand the engine a fake
 * RoomApi). Ids cross this boundary base62-encoded, matching the CLI's opaque-id
 * discipline everywhere else.
 */

export interface RoomProject {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
}

export interface RoomEndpoint {
  id: string;
  projectId: string;
  name: string;
  slug: string;
}

export interface RoomEndpointDetail {
  slug: string;
  signingEnabled: boolean;
  signingHeader: string | null;
}

/** One invite row on an endpoint - a seat when guestName is present. */
export interface RoomSeat {
  inviteId: string;
  ref: string;
  guestName: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface RoomCaptureRow {
  id: string;
  createdAt: string;
  signerLabel: string | null;
  body: string | null;
  contentType: string | null;
}

export interface RoomFeedPage {
  rows: RoomCaptureRow[];
  nextCursor: string | null;
  readAs: string | null;
}

export interface RoomMint {
  pairingCode: string;
  ref: string;
  participantName: string;
  expiresAt: string;
  codeExpiresAt: string;
}

/** One collection row for the console's curation verbs (#251). */
export interface RoomCollection {
  id: string;
  name: string;
  itemCount: number;
}

export interface RoomApi {
  listProjects(): Promise<RoomProject[]>;
  listEndpoints(projectId: string): Promise<RoomEndpoint[]>;
  /**
   * :create endpoint (#242): the same POST the create_endpoint MCP tool makes.
   * Born-signed is the CALLER's second step (enableSigning), so a signing failure
   * can render an honest partial receipt instead of losing the endpoint.
   */
  createEndpoint(projectId: string, name: string, slug: string): Promise<{ id: string; slug: string; captureUrlPath: string }>;
  /**
   * Enable inbound HMAC signing exactly the way set_endpoint_signing does: key
   * generated locally, registered with the server, persisted in the local
   * keystore only after the server accepted (the pair cannot drift).
   */
  enableSigning(projectId: string, endpointId: string): Promise<{ header: string }>;
  listCollections(projectId: string, endpointId: string): Promise<RoomCollection[]>;
  /** Create a collection pinning the given feed captures (the server refuses an empty one). */
  createCollection(projectId: string, endpointId: string, name: string, captureIds: string[]): Promise<{ id: string; name: string }>;
  addToCollection(projectId: string, endpointId: string, collectionId: string, captureIds: string[]): Promise<{ addedCount: number }>;
  getEndpointDetail(projectId: string, endpointId: string): Promise<RoomEndpointDetail>;
  listSeats(endpointId: string): Promise<RoomSeat[]>;
  mintSeat(endpointId: string, guestName: string): Promise<RoomMint>;
  revokeInvite(endpointId: string, inviteId: string): Promise<void>;
  /**
   * Long-poll the capture stream; cursor null starts from now-ish (latest page).
   * The signal aborts an in-flight wait so graceful teardown never hangs on it (#253).
   */
  waitCaptures(endpointId: string, after: string | null, timeoutSeconds: number, signal?: AbortSignal): Promise<RoomFeedPage>;
  listCaptures(endpointId: string, take: number): Promise<RoomFeedPage>;
  /** Whether the local keystore holds a signing key for the endpoint. */
  hasSigningKey(endpointId: string): boolean;
  post(opts: { projectId: string; endpointSlug: string; endpointId: string; body: string; signingHeader: string | null }): Promise<IntentDelivery>;
}

interface WireInviteItem {
  Id: string;
  Ref: string;
  Status: string;
  GuestName?: string | null;
  ExpiresAt: string;
  CreatedAt: string;
}

interface WireCaptureItem {
  Id: string;
  CreatedAt: string;
  MatchedSignerLabel?: string | null;
  Body?: string | null;
  ContentType?: string | null;
}

/**
 * A feed short id back to the GUID the collection endpoints want. A garbled id
 * answers with the console's friendly line through the AuthApiError channel the
 * engine already maps - never a stack trace in the feed.
 */
function toCaptureGuid(base62Id: string): string {
  try {
    return base62ToGuid(base62Id);
  } catch {
    throw new AuthApiError(400, 'invalid_capture_id', msg.invalidCaptureId(base62Id));
  }
}

function toFeedPage(result: Record<string, unknown>): RoomFeedPage {
  const rows = ((result.Requests as WireCaptureItem[] | undefined) ?? []).map((r) => ({
    id: guidToBase62(r.Id),
    createdAt: r.CreatedAt,
    signerLabel: r.MatchedSignerLabel ?? null,
    body: r.Body ?? null,
    contentType: r.ContentType ?? null,
  }));
  const scope = result.Scope as { ReadAs?: string } | null | undefined;
  return {
    rows,
    nextCursor: (result.NextCursor as string | undefined) ?? null,
    readAs: scope?.ReadAs ?? null,
  };
}

export function createRoomApi(client: AuthApiClient): RoomApi {
  return {
    async listProjects() {
      const res = (await client.get('/api/v1/projects')) as {
        Projects?: Array<{ Id: string; Name: string; Slug: string; Suspended?: boolean }>;
      };
      return (res.Projects ?? []).map((p) => ({
        id: guidToBase62(p.Id),
        name: p.Name,
        slug: p.Slug,
        suspended: p.Suspended === true,
      }));
    },

    async listEndpoints(projectId) {
      const res = (await client.get(`/api/v1/projects/${projectId}/endpoints`)) as {
        Endpoints?: Array<{ Id: string; ProjectId: string; Name: string; Slug: string }>;
      };
      return (res.Endpoints ?? []).map((e) => ({
        id: guidToBase62(e.Id),
        projectId,
        name: e.Name,
        slug: e.Slug,
      }));
    },

    async createEndpoint(projectId, name, slug) {
      const res = (await client.post(`/api/v1/projects/${projectId}/endpoints`, {
        Name: name,
        Slug: slug,
      })) as { Id?: string; Slug?: string };
      const id = res.Id ? guidToBase62(res.Id) : '';
      const createdSlug = res.Slug ?? slug;
      return { id, slug: createdSlug, captureUrlPath: `/api/v1/capture/${projectId}/${createdSlug}` };
    },

    async enableSigning(projectId, endpointId) {
      const header = 'X-Flurry-Signature';
      const key = generateSigningKey();
      await client.put(`/api/v1/projects/${projectId}/endpoints/${endpointId}/signing-key`, {
        Key: key,
        SigningHeader: header,
        SignatureScheme: 'simple',
      });
      // Persist locally only after the server accepted - the pair can't drift.
      putCredential(signingKeyRef(endpointId), {
        type: 'signing',
        value: key,
        createdAt: new Date().toISOString(),
      });
      return { header };
    },

    async listCollections(projectId, endpointId) {
      const res = (await client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}/collections`)) as {
        Collections?: Array<{ Id: string; Name: string; ItemCount?: number }>;
      };
      return (res.Collections ?? []).map((c) => ({
        id: guidToBase62(c.Id),
        name: c.Name,
        itemCount: c.ItemCount ?? 0,
      }));
    },

    async createCollection(projectId, endpointId, name, captureIds) {
      const res = (await client.post(`/api/v1/projects/${projectId}/endpoints/${endpointId}/collections`, {
        Name: name,
        Description: null,
        CapturedRequestIds: captureIds.map((id) => toCaptureGuid(id)),
      })) as { Id?: string; Name?: string };
      return { id: res.Id ? guidToBase62(res.Id) : '', name: res.Name ?? name };
    },

    async addToCollection(projectId, endpointId, collectionId, captureIds) {
      const res = (await client.post(
        `/api/v1/projects/${projectId}/endpoints/${endpointId}/collections/${collectionId}/captures`,
        { CapturedRequestIds: captureIds.map((id) => toCaptureGuid(id)) },
      )) as { AddedCount?: number };
      return { addedCount: res.AddedCount ?? 0 };
    },

    async getEndpointDetail(projectId, endpointId) {
      const res = (await client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}`)) as {
        Slug?: string;
        SigningEnabled?: boolean | null;
        SigningHeader?: string | null;
      };
      return {
        slug: res.Slug ?? '',
        // Fail closed unless the server EXPLICITLY reports signing disabled (the
        // post/post_intent rule).
        signingEnabled: res.SigningEnabled !== false,
        signingHeader: res.SigningHeader ?? null,
      };
    },

    async listSeats(endpointId) {
      const res = (await client.get(`/api/v1/endpoints/${endpointId}/invites/`)) as {
        Items?: WireInviteItem[];
      };
      // A seat is an invite row carrying a GuestName (the participant's stream identity).
      return (res.Items ?? [])
        .filter((i) => typeof i.GuestName === 'string' && i.GuestName.length > 0)
        .map((i) => ({
          inviteId: guidToBase62(i.Id),
          ref: i.Ref,
          guestName: i.GuestName as string,
          status: i.Status,
          expiresAt: i.ExpiresAt,
          createdAt: i.CreatedAt,
        }));
    },

    async mintSeat(endpointId, guestName) {
      // The shared mint call (#297): one wire shape for every chair surface.
      return mintSeatInvite(client, endpointId, guestName);
    },

    async revokeInvite(endpointId, inviteId) {
      await client.delete(`/api/v1/endpoints/${endpointId}/invites/${inviteId}`);
    },

    async waitCaptures(endpointId, after, timeoutSeconds, signal) {
      const qs =
        (after ? `after=${encodeURIComponent(after)}&` : '') +
        `timeoutSeconds=${timeoutSeconds}&includeBody=true`;
      const res = await client.get(`/api/v1/endpoints/${endpointId}/captured-requests/wait?${qs}`, { signal });
      return toFeedPage(res);
    },

    async listCaptures(endpointId, take) {
      const res = await client.get(
        `/api/v1/endpoints/${endpointId}/captured-requests?skip=0&take=${take}&includeBody=true`,
      );
      return toFeedPage(res);
    },

    hasSigningKey(endpointId) {
      return chooseIntentKey(endpointId) !== null;
    },

    async post(opts) {
      const chosen = chooseIntentKey(opts.endpointId);
      return deliverIntent({
        baseUrl: client.baseUrl,
        projectId: opts.projectId,
        endpointSlug: opts.endpointSlug,
        body: opts.body,
        signingKey: chosen?.credential.value ?? null,
        headerName: opts.signingHeader,
      });
    },
  };
}
