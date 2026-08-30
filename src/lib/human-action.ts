import { resolveWebBaseUrl } from './mcp-meta.js';

/**
 * #353: the exact thing a person has to go and do, and where.
 *
 * A cold host hit a wall on 2026-08-22: removal was human-only, the refusal said so,
 * and the answer pointed at the workspace in general. The agent could not tell its
 * human which project, which endpoint, which collection, or which item. Every outcome
 * only a human can finish now carries one of these instead: a label to say out loud,
 * a URL that opens the right page, and the opaque id of the thing being acted on.
 *
 * The URLs are the routes the workspace actually serves (Core.Web Routes/index.ts and
 * the Users.Web internal routes), so a link here is always a page that exists. Where a
 * surface has no route of its own - the endpoint's Collections tab, the Routing dialog -
 * the link goes to the deepest page that does route, and the label says what to open
 * once there. It never degrades to a bare /workspace or /dashboard when a project and
 * endpoint are known.
 */
export interface HumanAction {
  /** What the person does, sentence case, addressed to them. */
  label: string;
  /** Absolute workspace URL for the exact page. */
  url: string;
  /** Opaque id of the thing being acted on, verbatim. */
  targetId: string;
}

/** Absolute workspace URL for a routed path. */
export function workspaceUrl(path: string): string {
  return `${resolveWebBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The paths the workspace routes today. Nothing here is invented. */
export const workspacePath = {
  dashboard: (): string => '/dashboard',
  project: (projectSlug: string): string => `/projects/${projectSlug}`,
  endpoint: (projectSlug: string, endpointSlug: string): string =>
    `/projects/${projectSlug}/endpoints/${endpointSlug}`,
  capture: (projectSlug: string, endpointSlug: string, captureId: string): string =>
    `/projects/${projectSlug}/endpoints/${endpointSlug}/requests/${captureId}`,
  domains: (): string => '/domains',
  billing: (): string => '/billing',
  settings: (): string => '/settings',
};

export function humanAction(label: string, path: string, targetId: string): HumanAction {
  return { label, url: workspaceUrl(path), targetId };
}
