import type { ResolvedContext } from './config.js';
import { parseProblemDetails } from './fetch-error.js';
import { recordCliNotice, versionHeader } from './version-nudge.js';

export interface ApiClient {
  get: (path: string) => Promise<Record<string, unknown>>;
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly detail: string,
    public readonly raw: Record<string, unknown> | null,
    /** Machine error code from the shared ProblemDetails parse (status-derived fallback otherwise). */
    public readonly code: string = 'error',
  ) {
    super(detail || `${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

export function createApiClient(context: ResolvedContext): ApiClient {
  const baseUrl = context.apiUrl.replace(/\/$/, '');

  const baseHeaders: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${context.apiKey}`,
    ...versionHeader(),
  };

  const handleResponse = async (res: Response): Promise<Record<string, unknown>> => {
    // Latch the server's version-staleness notice (if any) for the meta builders.
    recordCliNotice(res);
    if (!res.ok) {
      if (res.status === 401) {
        console.error('\x1b[31mAuthentication failed.\x1b[0m Your token may be expired or invalid.');
        console.error('Run \x1b[36mflurryport login <token>\x1b[0m to set a new personal access token.');
        process.exit(1);
      }
      if (res.status === 403) {
        console.error('\x1b[31mAccess denied.\x1b[0m Your token does not have permission for this action.');
        process.exit(1);
      }
      const text = await res.text().catch(() => '');
      let raw: Record<string, unknown> | null = null;
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // not JSON - the parser keeps the raw text as detail
      }
      const { code, detail } = parseProblemDetails(res.status, text);
      throw new ApiError(res.status, res.statusText, detail, raw, code);
    }
    return res.json() as Promise<Record<string, unknown>>;
  };

  return {
    get: async (path: string) => {
      const res = await fetch(`${baseUrl}${path}`, { headers: baseHeaders });
      return handleResponse(res);
    },
    post: async (path: string, body: unknown) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return handleResponse(res);
    },
  };
}
