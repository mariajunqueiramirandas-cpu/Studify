// Runtime settings. The API writes them into index.html when it serves the page (apps/api/src/dashboard.ts), so
// one build works for every deployment. Both values are public: the project URL and the publishable key.

export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export function readConfig(doc: Document = document): RuntimeConfig | null {
  const raw = doc.querySelector('meta[name="studify-config"]')?.getAttribute('content') ?? '';
  try {
    const value = JSON.parse(raw) as Partial<RuntimeConfig>;
    if (typeof value.supabaseUrl === 'string' && value.supabaseUrl && typeof value.supabaseAnonKey === 'string' && value.supabaseAnonKey) {
      return { supabaseUrl: value.supabaseUrl, supabaseAnonKey: value.supabaseAnonKey };
    }
  } catch {
    // The placeholder was not replaced: the page was opened without the API in front of it.
  }
  return null;
}
