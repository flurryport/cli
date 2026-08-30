import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface AccountConfig {
  apiKey: string;
  /**
   * Endpoint binding for scoped invite grants (base62 ids, from the release receipt).
   * The credential router uses these to answer reads of the joined endpoint with THIS
   * credential while the operator's own account answers everything else — no account
   * switching. Absent on full-scope accounts and grants joined by pre-0.3.0 CLIs.
   */
  scopeEndpointId?: string;
  scopeProjectId?: string;
}

/**
 * Turn a participant name from an invite ("Tom", "bunny", "ts:codex") into the CLI
 * account name the grant parks under — the same identity the signer label and watch
 * label carry (0.3.0 naming pipeline). Lowercased, whitespace to '-', restricted to
 * [a-z0-9:._-], capped at 40 chars; anything unusable falls back to 'guest'.
 */
export function participantAccountName(name?: string | null): string {
  const cleaned = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9:._-]/g, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'guest';
}

export interface EnvironmentConfig {
  apiUrl: string;
  activeAccount?: string;
  accounts: Record<string, AccountConfig>;
}

export interface FlurryConfig {
  activeEnvironment: string;
  environments: Record<string, EnvironmentConfig>;
}

/** Resolved view of the active environment + account, used by command code. */
export interface ResolvedContext {
  environmentName: string;
  apiUrl: string;
  accountName: string;
  apiKey: string;
}

const CONFIG_DIR = join(homedir(), '.flurryport');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const PROD_API_URL = 'https://api.flurryport.io';
export const PROD_ENV_NAME = 'prod';

const DEFAULT_CONFIG: FlurryConfig = {
  activeEnvironment: PROD_ENV_NAME,
  environments: {
    [PROD_ENV_NAME]: {
      apiUrl: PROD_API_URL,
      accounts: {},
    },
  },
};

export function loadConfig(): FlurryConfig {
  if (!existsSync(CONFIG_FILE)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const migrated = migrateConfig(parsed);
    if (migrated !== parsed) saveConfig(migrated);
    return migrated;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Migrate older config formats to the current shape.
 * - Pre-profile flat config: { apiUrl, apiKey, ... }
 * - Profile-based config: { activeProfile, profiles: { <name>: { apiUrl, apiKey, ... } } }
 *
 * Each migration target lands in the prod environment if its apiUrl matches PROD_API_URL,
 * otherwise it becomes its own environment named after the profile.
 */
function migrateConfig(parsed: unknown): FlurryConfig {
  if (parsed && typeof parsed === 'object' && 'environments' in parsed && 'activeEnvironment' in parsed) {
    return parsed as FlurryConfig;
  }

  const config: FlurryConfig = structuredClone(DEFAULT_CONFIG);

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    // Old profile-based format
    if (obj.profiles && typeof obj.profiles === 'object') {
      const profiles = obj.profiles as Record<string, { apiUrl?: string; apiKey?: string }>;
      const activeProfile = typeof obj.activeProfile === 'string' ? obj.activeProfile : 'default';

      for (const [profileName, profile] of Object.entries(profiles)) {
        const apiUrl = profile.apiUrl ?? PROD_API_URL;
        const targetEnv = apiUrl === PROD_API_URL ? PROD_ENV_NAME : profileName;
        if (!config.environments[targetEnv]) {
          config.environments[targetEnv] = { apiUrl, accounts: {} };
        }
        const accountName = targetEnv === PROD_ENV_NAME ? profileName : 'default';
        if (profile.apiKey) {
          config.environments[targetEnv].accounts[accountName] = { apiKey: profile.apiKey };
          if (!config.environments[targetEnv].activeAccount) {
            config.environments[targetEnv].activeAccount = accountName;
          }
        }
        if (profileName === activeProfile) {
          config.activeEnvironment = targetEnv;
        }
      }
      return config;
    }

    // Old flat format
    if (typeof obj.apiUrl === 'string') {
      const apiUrl = obj.apiUrl;
      const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey : undefined;
      const targetEnv = apiUrl === PROD_API_URL ? PROD_ENV_NAME : 'custom';
      config.environments[targetEnv] = { apiUrl, accounts: {} };
      if (apiKey) {
        config.environments[targetEnv].accounts.default = { apiKey };
        config.environments[targetEnv].activeAccount = 'default';
      }
      config.activeEnvironment = targetEnv;
      return config;
    }
  }

  return config;
}

/**
 * #170: true when the config is exactly the out-of-the-box shape — a single
 * environment named prod pointing at the prod API URL. In that state the
 * "environment" concept is an internal detail the user never created, so
 * user-facing strings suppress the environment clause. Full wording returns as
 * soon as another environment exists, the single environment is non-default, or
 * the user explicitly passed --environment (they know the concept).
 */
export function isDefaultProdOnly(config: FlurryConfig): boolean {
  const names = Object.keys(config.environments);
  return (
    names.length === 1 &&
    names[0] === PROD_ENV_NAME &&
    config.environments[PROD_ENV_NAME].apiUrl === PROD_API_URL
  );
}

export function saveConfig(config: FlurryConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function getEnvironment(config: FlurryConfig, name?: string): { name: string; env: EnvironmentConfig } {
  const envName = name ?? config.activeEnvironment;
  const env = config.environments[envName];
  if (!env) {
    console.error(`\x1b[31mEnvironment "${envName}" not found.\x1b[0m`);
    console.error(`Available: ${Object.keys(config.environments).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return { name: envName, env };
}

export function resolveContext(
  config: FlurryConfig,
  opts: { environment?: string; account?: string } = {},
): ResolvedContext {
  // #170: only mention environments when the user has actually met the concept
  // (a non-default config, or an explicit --environment).
  const plainWording = !opts.environment && isDefaultProdOnly(config);
  const { name: environmentName, env } = getEnvironment(config, opts.environment);
  const accountName = opts.account ?? env.activeAccount;
  if (!accountName) {
    console.error(plainWording
      ? `\x1b[31mNo active account.\x1b[0m`
      : `\x1b[31mNo active account in environment "${environmentName}".\x1b[0m`);
    console.error(`Add one with: flurryport login <token>`);
    process.exit(1);
  }
  const account = env.accounts[accountName];
  if (!account) {
    console.error(plainWording
      ? `\x1b[31mAccount "${accountName}" not found.\x1b[0m`
      : `\x1b[31mAccount "${accountName}" not found in environment "${environmentName}".\x1b[0m`);
    console.error(`Available: ${Object.keys(env.accounts).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return {
    environmentName,
    apiUrl: env.apiUrl,
    accountName,
    apiKey: account.apiKey,
  };
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
