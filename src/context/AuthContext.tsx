import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { supabase } from '../Supabase/client';

interface AuthContextType {
  isAuthenticated: boolean;
  user: { id: string; email: string | null; name?: string } | null;
  loading: boolean;
  isInPasswordRecovery: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithPhone: (countryCode: string, phoneNumber: string, password: string) => Promise<void>;
  sendPhoneOtp: (countryCode: string, phoneNumber: string) => Promise<void>;
  verifyPhoneOtp: (countryCode: string, phoneNumber: string, otpCode: string) => Promise<void>;
  signup: (params: {
    name: string;
    email: string;
    password: string;
    profession?: string;
    hospital?: string;
    whatsappNumber?: string;
  }) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Storage key for user info only
const AUTH_USER_STORAGE_KEY = 'vmtb.auth.user';

const canUseStorage = () => typeof window !== 'undefined' && !!window.localStorage;

const storeUser = (user: { id: string; email: string | null; name?: string } | null) => {
  if (!canUseStorage()) return;
  if (!user) {
    window.localStorage.removeItem(AUTH_USER_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
};

const readStoredUser = (): { id: string; email: string | null; name?: string } | null => {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(AUTH_USER_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { id: string; email: string | null; name?: string };
  } catch (_err) {
    return null;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string; email: string | null; name?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [isInPasswordRecovery, setIsInPasswordRecovery] = useState(false);
  const isAuthenticated = !!user;

  const backfillProfileFromMetadata = async (id: string) => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const meta = (authData.user as any)?.user_metadata || {};
      const fullName = meta.name as string | undefined;
      const profession = meta.profession as string | undefined;
      const hospital = meta.hospital as string | undefined;
      const whatsappNumber = meta.whatsappNumber as string | undefined;

      if (!fullName && !profession && !hospital && !whatsappNumber) return;

      await supabase.from('profiles').upsert({
        id,
        full_name: fullName,
        profession,
        hospital,
        whatsapp_number: whatsappNumber,
      }, { onConflict: 'id' });

      if (fullName) {
        setUser(prev => (prev ? { ...prev, name: fullName } : prev));
      }
    } catch (_err) {
      // Ignore failures; do not block auth flow
    }
  };

  const loadProfileName = async (id: string) => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', id)
        .single();
      const name = (data as { full_name?: string } | null)?.full_name;
      if (name) {
        setUser(prev => (prev ? { ...prev, name } : prev));
      } else {
        await backfillProfileFromMetadata(id);
      }
    } catch (_err) {
      // Ignore missing profile; keep auth working without name
      await backfillProfileFromMetadata(id);
    }
  };

  useEffect(() => {
    // Check if we're on reset-password page with a hash (recovery link)
    const isOnResetPasswordWithHash = 
      typeof window !== 'undefined' && 
      window.location.pathname === '/reset-password' && 
      window.location.hash.includes('access_token');

    // Load cached user immediately to avoid flicker while Supabase initializes
    // BUT skip if on reset-password with hash to avoid race condition
    if (!isOnResetPasswordWithHash) {
      const cachedUser = readStoredUser();
      if (cachedUser) {
        setUser(cachedUser);
      }
    }

    let initialSessionHandled = false;

    // Subscribe to auth state changes - this handles initial session load AND subsequent changes
    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[AUTH] State change:', event, session?.user?.email);
      
      // Track PASSWORD_RECOVERY event specifically
      if (event === 'PASSWORD_RECOVERY') {
        console.log('[AUTH] Password recovery mode detected');
        setIsInPasswordRecovery(true);
      } else if (event === 'SIGNED_OUT') {
        // Reset recovery flag when user signs out
        setIsInPasswordRecovery(false);
      }
      
      const u = session?.user;
      if (u) {
        const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
        setUser(userData);
        storeUser(userData);
        // Fire-and-forget profile name fetch
        loadProfileName(u.id);
      } else {
        setUser(null);
        storeUser(null);
      }
      
      // Set loading false after initial session check
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        if (!initialSessionHandled) {
          initialSessionHandled = true;
          setLoading(false);
        }
      }
    });

    // Fallback: If INITIAL_SESSION doesn't fire within 2 seconds, set loading false
    const fallbackTimeout = setTimeout(() => {
      if (!initialSessionHandled) {
        console.log('[AUTH] Fallback: Setting loading false');
        initialSessionHandled = true;
        setLoading(false);
      }
    }, 2000);

    // Listen for user info changes from other tabs
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === AUTH_USER_STORAGE_KEY) {
        const newUser = readStoredUser();
        setUser(newUser);
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      clearTimeout(fallbackTimeout);
      authSub.subscription.unsubscribe();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  const login = async (email: string, password: string) => {
    const { error, data } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
      setUser(userData);
      storeUser(userData);
      // Fire-and-forget profile name fetch to avoid blocking UI
      loadProfileName(u.id);
    }
  };

  const loginWithPhone = async (countryCode: string, phoneNumber: string, password: string) => {
    // Construct E.164 format phone number (with +)
    const cleanCountryCode = countryCode.replace(/\D/g, '');
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const phoneE164 = `+${cleanCountryCode}${cleanPhoneNumber}`;
    
    // Debug logging - remove after fixing
    console.log('[DEBUG] Phone login payload:', {
      phone: phoneE164,
      passwordLength: password.length,
      rawCountryCode: countryCode,
      rawPhoneNumber: phoneNumber
    });
    
    const { error, data } = await supabase.auth.signInWithPassword({ 
      phone: phoneE164, 
      password 
    });
    if (error) throw error;
    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
      setUser(userData);
      storeUser(userData);
      // Fire-and-forget profile name fetch to avoid blocking UI
      loadProfileName(u.id);
    }
  };

  const sendPhoneOtp = async (countryCode: string, phoneNumber: string) => {
    // Construct E.164 format phone number (with +)
    const cleanCountryCode = countryCode.replace(/\D/g, '');
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const phoneE164 = `+${cleanCountryCode}${cleanPhoneNumber}`;
    
    console.log('[DEBUG] Sending OTP to:', phoneE164);
    
    const { error } = await supabase.auth.signInWithOtp({ 
      phone: phoneE164 
    });
    if (error) throw error;
  };

  const verifyPhoneOtp = async (countryCode: string, phoneNumber: string, otpCode: string) => {
    // Construct E.164 format phone number (with +)
    const cleanCountryCode = countryCode.replace(/\D/g, '');
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const phoneE164 = `+${cleanCountryCode}${cleanPhoneNumber}`;
    
    console.log('[DEBUG] Verifying OTP for:', phoneE164);
    
    const { error, data } = await supabase.auth.verifyOtp({ 
      phone: phoneE164,
      token: otpCode,
      type: 'sms'
    });
    if (error) throw error;
    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name: (u as any)?.user_metadata?.name };
      setUser(userData);
      storeUser(userData);
      // Fire-and-forget profile name fetch to avoid blocking UI
      loadProfileName(u.id);
    }
  };

  const signup = async ({ name, email, password, profession, hospital, whatsappNumber }: {
    name: string; email: string; password: string; profession?: string; hospital?: string; whatsappNumber?: string;
  }) => {
    const { error, data } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, profession, hospital, whatsappNumber },
      },
    });
    if (error) throw error;
    const u = data.user;
    if (u) {
      const userData = { id: u.id, email: u.email ?? null, name };
      setUser(userData);
      storeUser(userData);
      // Create profile record
      await supabase.from('profiles').upsert({
        id: u.id,
        full_name: name,
        profession,
        hospital,
        whatsapp_number: whatsappNumber,
      }, { onConflict: 'id' });
    }
  };

  const requestPasswordReset = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password',
    });
    if (error) throw error;
  };

  const logout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setUser(null);
    storeUser(null);
  };

  const value = useMemo(() => ({ isAuthenticated, user, loading, isInPasswordRecovery, login, loginWithPhone, sendPhoneOtp, verifyPhoneOtp, signup, requestPasswordReset, logout }), [isAuthenticated, user, loading, isInPasswordRecovery]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
