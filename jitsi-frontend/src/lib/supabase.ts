import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

let supabaseClient: SupabaseClient | null = null;

/**
 * Initialize and get the Supabase client
 * Uses singleton pattern to avoid multiple instances
 */
export function getSupabaseClient(): SupabaseClient | null {
  // Check if Supabase is configured
  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('[SUPABASE] Missing environment variables. Analytics will be disabled.');
    console.warn('[SUPABASE] Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
    return null;
  }

  // Security check - don't use service role key in browser
  if (supabaseAnonKey.includes('secret') || supabaseAnonKey.startsWith('sb_secret_')) {
    console.error('[SUPABASE] ⚠️ SECURITY ERROR: Service role key detected in browser!');
    return null;
  }

  // Return existing client if already initialized
  if (supabaseClient) {
    return supabaseClient;
  }

  // Create new client
  supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false, // No user auth needed for analytics
      autoRefreshToken: false,
    },
  });

  console.log('[SUPABASE] ✓ Client initialized for meeting analytics');
  return supabaseClient;
}

/**
 * Check if Supabase is properly configured
 */
export function isSupabaseConfigured(): boolean {
  return !!(supabaseUrl && supabaseAnonKey);
}
