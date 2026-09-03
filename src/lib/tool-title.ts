/**
 * Tool titles (#479): the MCP `title` annotation is the human label a client shows
 * where the snake_case name would be ugly (Claude Desktop's extension panel, the
 * Anthropic directory listing). Every registerTool site carries a literal title;
 * the auth read() helper derives its dozen from the name with this same rule, and
 * the surface test holds every tool to it: sentence case, no underscores, short.
 */
/** Titles that must say what the generic name does not (Codex reviewer run 2026-09-02): the
 *  host shows these beside a filesystem's own notion of projects and endpoints. */
const OVERRIDES: Record<string, string> = {
  list_projects: 'List FlurryPORT projects',
  get_project: 'Get FlurryPORT project',
  list_endpoints: 'List webhook endpoints',
  get_endpoint: 'Get webhook endpoint',
};

export function toolTitle(name: string): string {
  if (OVERRIDES[name]) return OVERRIDES[name];
  const words = name.split('_').map((w) => (w === 'url' ? 'URL' : w));
  const head = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.length > 1 ? `${head} ${words.slice(1).join(' ')}` : head;
}
