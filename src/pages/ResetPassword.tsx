import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../Supabase/client';
import { useIsMobile } from '../hooks/useMobile';
import { useAuth } from '../context/AuthContext';

export function ResetPassword() {
  const navigate = useNavigate();
  const { isInPasswordRecovery } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isRecoveryMode, setIsRecoveryMode] = useState(isInPasswordRecovery);
  const isMobile = useIsMobile();

  useEffect(() => {
    // Update local recovery mode if global context says we're in recovery
    if (isInPasswordRecovery) {
      setIsRecoveryMode(true);
      setError(null);
    }
  }, [isInPasswordRecovery]);

  useEffect(() => {
    // Listen for PASSWORD_RECOVERY event - this activates when user clicks recovery link
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[RESET PASSWORD] Auth event:', event, 'Has session:', !!session);
      
      if (event === 'PASSWORD_RECOVERY') {
        console.log('[RESET PASSWORD] Password recovery mode activated');
        setIsRecoveryMode(true);
        setError(null);
      } else if (event === 'SIGNED_IN' && session) {
        // Alternative: user might already have session from recovery link
        setIsRecoveryMode(true);
        setError(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: password,
      });

      if (updateError) {
        console.error('[RESET PASSWORD] Update error:', updateError);
        throw updateError;
      }

      console.log('[RESET PASSWORD] Password updated successfully');
      setSuccess(true);
      
      // Sign out user to clear recovery session, then redirect to login
      await supabase.auth.signOut();
      setTimeout(() => {
        navigate('/login');
      }, 2000);
    } catch (err: any) {
      console.error('[RESET PASSWORD] Error:', err);
      const errorMsg = err?.message || 'Failed to reset password';
      
      // Specific error handling for recovery mode issues
      if (errorMsg.includes('not authenticated') || errorMsg.includes('no session')) {
        setError('Recovery link has expired. Please request a new reset email.');
      } else if (errorMsg.includes('invalid')) {
        setError('Invalid recovery link. Please request a new reset email.');
      } else {
        setError(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-sm p-8">
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-gray-900">vMTB</h1>
          </div>

          {success ? (
            <div className="text-center">
              <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
                <p className="text-green-800 font-semibold text-sm">Password Reset Successful!</p>
                <p className="text-green-700 mt-2 text-sm">Redirecting to login...</p>
              </div>
            </div>
          ) : !isRecoveryMode ? (
            // Waiting for recovery mode to initialize
            <div className="text-center">
              <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 font-semibold text-sm">Initializing Password Recovery...</p>
                <p className="text-blue-700 mt-2 text-sm">Please wait while we verify your recovery link</p>
              </div>
              <div className="flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderBottomColor: '#4A90E2' }}></div>
              </div>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2 text-center">
                Reset Your Password
              </h2>
              <p className="text-center text-gray-600 mb-8" style={{ color: '#4A5565' }}>
                Enter your new password
              </p>

              {error && (
                <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-800 text-sm">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-900 mb-2">
                    New Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                    style={{ '--tw-ring-color': '#4A90E2', fontSize: '16px' } as React.CSSProperties}
                    placeholder="Enter new password"
                    required
                    disabled={loading}
                  />
                </div>

                <div>
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-900 mb-2">
                    Confirm Password
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                    style={{ '--tw-ring-color': '#4A90E2', fontSize: '16px' } as React.CSSProperties}
                    placeholder="Confirm new password"
                    required
                    disabled={loading}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: '#4A90E2' }}
                  onMouseEnter={(e) => !loading && (e.currentTarget.style.backgroundColor = '#357ABD')}
                  onMouseLeave={(e) => !loading && (e.currentTarget.style.backgroundColor = '#4A90E2')}
                >
                  {loading ? 'Resetting...' : 'Reset Password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
