// Which backend holds the files, from the process environment (API and worker read the same variables).
//   STORAGE_PROVIDER       r2 | supabase   (default: r2 when R2_BUCKET is set, else supabase)
//   R2_ACCOUNT_ID          Cloudflare account id (dashboard > R2 > Overview)
//   R2_ACCESS_KEY_ID       R2 API token, Object Read & Write on the bucket
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET              the R2 bucket that holds every logical bucket (e.g. studify)
//   R2_ENDPOINT            optional S3 endpoint (EU jurisdiction buckets, or a local S3 server)
import type { SupabaseClient } from '@supabase/supabase-js';
import { r2Storage, type R2Config } from './r2.ts';
import { supabaseStorage } from './supabase.ts';
import type { ObjectStorage } from './types.ts';

export type StorageConfig = { provider: 'supabase' } | { provider: 'r2'; r2: R2Config };

export class StorageConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid storage configuration: ${problems.join('; ')}`);
    this.name = 'StorageConfigError';
  }
}

const R2_REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

export function storageConfigFromEnv(env: Record<string, string | undefined>): StorageConfig {
  const value = (key: string) => {
    const v = env[key]?.trim();
    return v && v.length > 0 ? v : undefined;
  };
  const provider = value('STORAGE_PROVIDER') ?? (value('R2_BUCKET') ? 'r2' : 'supabase');
  if (provider === 'supabase') return { provider };
  if (provider !== 'r2') throw new StorageConfigError([`STORAGE_PROVIDER must be r2 or supabase, not "${provider}"`]);

  const problems = R2_REQUIRED.filter((key) => !value(key)).map((key) => `${key} is missing (STORAGE_PROVIDER=r2)`);
  const endpoint = value('R2_ENDPOINT');
  if (endpoint && !/^https?:\/\/[^/\s]+/.test(endpoint)) problems.push('R2_ENDPOINT must be an http(s) URL');
  const accountId = value('R2_ACCOUNT_ID');
  if (accountId && !endpoint && !/^[0-9a-f]{32}$/i.test(accountId)) problems.push('R2_ACCOUNT_ID must be the 32-character account id');
  if (problems.length > 0) throw new StorageConfigError(problems);
  return {
    provider: 'r2',
    r2: {
      accountId: accountId as string,
      accessKeyId: value('R2_ACCESS_KEY_ID') as string,
      secretAccessKey: value('R2_SECRET_ACCESS_KEY') as string,
      bucket: value('R2_BUCKET') as string,
      ...(endpoint ? { endpoint } : {}),
    },
  };
}

/** The configured backend. The Supabase client is the service-role one (it is only used without R2). */
export function createStorage(config: StorageConfig, supabase: SupabaseClient): ObjectStorage {
  return config.provider === 'r2' ? r2Storage(config.r2) : supabaseStorage(supabase);
}
