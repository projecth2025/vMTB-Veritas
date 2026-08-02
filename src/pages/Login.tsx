import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const { login } = useAuth();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (!email.trim()) {
        setError('Email is required');
        setLoading(false);
        return;
      }
      if (!password.trim()) {
        setError('Password is required');
        setLoading(false);
        return;
      }
      await login(email, password);
      navigate('/my-cases');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
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

          <h2 className="text-2xl font-semibold text-gray-900 mb-2 text-center">
            Welcome Back
          </h2>
          <p className="text-center text-gray-600 mb-8">
            Login to your account
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
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition"
                style={{ fontSize: '16px', '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                placeholder="Enter your email"
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-900 mb-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition"
                style={{ fontSize: '16px', '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                placeholder="Enter your password"
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
              {loading ? 'Logging in...' : 'Login'}
            </button>
          </form>

          <div className="mt-7 text-center space-y-3">
            <Link
              to="/forgot-password"
              className="block text-sm font-medium transition"
              style={{ color: '#4A90E2' }}
            >
              Forgot your password?
            </Link>
            <div className="text-sm" style={{ color: '#4A5565' }}>
              Don't have an account?{' '}
              <Link
                to="/signup"
                className="font-semibold transition"
                style={{ color: '#4A90E2' }}
              >
                Sign up here
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
