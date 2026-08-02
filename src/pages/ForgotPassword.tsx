import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useMobile';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requestPasswordReset } = useAuth();
  const isMobile = useIsMobile();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset(email);
      setSubmitted(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to send reset link');
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

          {!submitted ? (
            <>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2 text-center">
                Forgot Your Password?
              </h2>
              <p className="text-center mb-8" style={{ color: '#4A5565' }}>
                No worries! Enter your email and we'll send you a reset link.
              </p>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-900 mb-2">
                    Email Address
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                    style={{ '--tw-ring-color': '#4A90E2', fontSize: '16px' } as React.CSSProperties}
                    placeholder="Enter your email"
                    required
                  />
                </div>

                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: '#4A90E2' }}
                  onMouseEnter={(e) => !loading && (e.currentTarget.style.backgroundColor = '#357ABD')}
                  onMouseLeave={(e) => !loading && (e.currentTarget.style.backgroundColor = '#4A90E2')}
                >
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>
            </>
          ) : (
            <div className="text-center">
              <div className="inline-flex items-center justify-center bg-green-100 rounded-full mb-6 w-16 h-16">
                <CheckCircle className="text-green-600 w-8 h-8" />
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">
                Check Your Email
              </h2>
              <p className="text-gray-600 mb-6" style={{ color: '#4A5565' }}>
                We've sent a password reset link to<br />
                <strong className="text-gray-900">{email}</strong>
              </p>
              <p className="text-sm text-gray-600">
                The link will expire in 1 hour. If you don't see the email, check your spam folder.
              </p>
            </div>
          )}

          <div className="mt-8 text-center">
            <Link
              to="/login"
              className="text-sm font-medium transition"
              style={{ color: '#4A90E2' }}
            >
              ← Back to login
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
