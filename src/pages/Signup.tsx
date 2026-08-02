import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import { sendWhatsAppOTP, verifyWhatsAppOTPAndCreateUser } from '../services/whatsappOtp';

type SignupStep = 'form' | 'otp';

export function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profession, setProfession] = useState('');
  const [hospital, setHospital] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // OTP verification state
  const [step, setStep] = useState<SignupStep>('form');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Handle resend cooldown timer
  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  // Focus first OTP input when step changes to OTP
  useEffect(() => {
    if (step === 'otp') {
      otpInputsRef.current[0]?.focus();
    }
  }, [step]);

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate all required fields
    if (!name.trim()) {
      showToast.error('Full name is required');
      return;
    }
    
    if (!email.trim()) {
      showToast.error('Email is required');
      return;
    }
    
    if (!profession) {
      showToast.error('Profession is required');
      return;
    }
    
    if (!hospital.trim()) {
      showToast.error('Hospital/Institution is required');
      return;
    }
    
    if (!phoneNumber.trim()) {
      showToast.error('Phone number is required');
      return;
    }
    
    // Validate phone number is digits only and reasonable length
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      showToast.error('Please enter a valid phone number (10-15 digits)');
      return;
    }
    
    if (password !== confirmPassword) {
      showToast.error('Passwords do not match');
      return;
    }
    
    if (password.length < 6) {
      showToast.error('Password must be at least 6 characters');
      return;
    }

    setError(null);
    setLoading(true);
    
    try {
      // User enters number including country code; normalize to E.164 shape.
      const cleanPhoneNum = phoneNumber.replace(/\D/g, '');
      const formattedPhone = `+${cleanPhoneNum}`;
      
      const result = await sendWhatsAppOTP(formattedPhone);
      
      if (!result.success) {
        setError(result.error || 'Failed to send OTP');
        return;
      }
      
      showToast.success('OTP sent to your WhatsApp');
      setStep('otp');
      setResendCooldown(60); // 60 seconds cooldown for resend
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send OTP';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendOTP = async () => {
    if (resendCooldown > 0) return;
    
    setLoading(true);
    try {
      const cleanPhoneNum = phoneNumber.replace(/\D/g, '');
      const formattedPhone = `+${cleanPhoneNum}`;
      
      const result = await sendWhatsAppOTP(formattedPhone);
      
      if (!result.success) {
        showToast.error(result.error || 'Failed to resend OTP');
        return;
      }
      
      showToast.success('OTP resent to your WhatsApp');
      setResendCooldown(60);
      setOtp(['', '', '', '', '', '']);
      otpInputsRef.current[0]?.focus();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resend OTP';
      showToast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return; // Only allow digits
    
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1); // Only take last character
    setOtp(newOtp);
    
    // Auto-focus next input
    if (value && index < 5) {
      otpInputsRef.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      otpInputsRef.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pastedData) {
      const newOtp = [...otp];
      for (let i = 0; i < pastedData.length && i < 6; i++) {
        newOtp[i] = pastedData[i];
      }
      setOtp(newOtp);
      // Focus the input after the last pasted digit
      const focusIndex = Math.min(pastedData.length, 5);
      otpInputsRef.current[focusIndex]?.focus();
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const otpString = otp.join('');
    if (otpString.length !== 6) {
      setError('Please enter the complete 6-digit OTP');
      return;
    }

    setError(null);
    setLoading(true);
    
    try {
      // Construct phone numbers in both formats
      const cleanPhoneNum = phoneNumber.replace(/\D/g, '');
      const phoneForProfile = cleanPhoneNum; // Without + for profiles
      const phoneForAuth = `+${cleanPhoneNum}`; // With + for auth (E.164)
      
      const result = await verifyWhatsAppOTPAndCreateUser({
        phone: phoneForProfile, // For OTP verification and profiles table
        phoneE164: phoneForAuth, // For auth.users.phone (E.164 format)
        otp: otpString,
        email,
        password,
        full_name: name,
        profession: profession || undefined,
        hospital: hospital || undefined,
      });
      
      if (!result.success) {
        setError(result.error || 'Failed to verify OTP');
        return;
      }
      
      showToast.success('Account created successfully! Please login.');
      
      // Sign in the user automatically after successful registration
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      
      if (signInError) {
        // If auto-login fails, redirect to login page
        navigate('/login');
      } else {
        navigate('/my-cases');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create account';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleBackToForm = () => {
    setStep('form');
    setOtp(['', '', '', '', '', '']);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-3xl">
        <div className="bg-white rounded-2xl shadow-sm p-8">
          {/* Header */}
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-gray-900">vMTB</h1>
          </div>

          {step === 'form' ? (
            <>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2 text-center">
                Create your account
              </h2>
              <p className="text-center text-gray-600 mb-8">
                Join our community of healthcare professionals
              </p>

              <form onSubmit={handleSendOTP}>
                {/* Two-column grid for desktop, single column for mobile */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                  {/* Left Column */}
                  <div className="space-y-5">
                    <div>
                      <label htmlFor="name" className="block text-sm font-medium text-gray-900 mb-2">
                        Full Name
                      </label>
                      <input
                        id="name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                        placeholder="Dr. John Doe"
                        required
                      />
                    </div>

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
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                        placeholder="doctor@hospital.com"
                        required
                      />
                    </div>

                    <div>
                      <label htmlFor="profession" className="block text-sm font-medium text-gray-900 mb-2">
                        Profession
                      </label>
                      <select
                        id="profession"
                        value={profession}
                        onChange={(e) => setProfession(e.target.value)}
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                        required
                      >
                        <option value="">Select profession</option>
                        <option value="Medical oncologist">Medical oncologist</option>
                        <option value="Surgical oncologist">Surgical oncologist</option>
                        <option value="Radiation oncologist">Radiation oncologist</option>
                        <option value="Hematologist-oncologist">Hematologist-oncologist</option>
                        <option value="Radiologist">Radiologist</option>
                        <option value="Pathologist">Pathologist</option>
                        <option value="Molecular pathologist">Molecular pathologist</option>
                        <option value="Medical physicist">Medical physicist</option>
                        <option value="Dosimetrist">Dosimetrist</option>
                        <option value="Radiation therapist">Radiation therapist</option>
                        <option value="Oncology nurse / staff nurse">Oncology nurse / staff nurse</option>
                        <option value="Infusion nurse">Infusion nurse</option>
                        <option value="Oncology pharmacist">Oncology pharmacist</option>
                        <option value="Palliative care specialist">Palliative care specialist</option>
                        <option value="Dietitian / oncology nutritionist">Dietitian / oncology nutritionist</option>
                        <option value="Genetic counselor">Genetic counselor</option>
                        <option value="Cardio-oncologist">Cardio-oncologist</option>
                        <option value="Pulmonologist">Pulmonologist</option>
                        <option value="Nephrologist">Nephrologist</option>
                        <option value="Hepatologist">Hepatologist</option>
                        <option value="Endocrinologist">Endocrinologist</option>
                        <option value="Oral surgeon">Oral surgeon</option>
                        <option value="Administrative staff">Administrative staff</option>
                        <option value="Geneticist">Geneticist</option>
                        <option value="Genomicist">Genomicist</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="hospital" className="block text-sm font-medium text-gray-900 mb-2">
                        Hospital / Institution
                      </label>
                      <input
                        id="hospital"
                        type="text"
                        value={hospital}
                        onChange={(e) => setHospital(e.target.value)}
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                        placeholder="City Cancer Hospital"
                        required
                      />
                    </div>
                  </div>

                  {/* Right Column */}
                  <div className="space-y-5">
                    <div>
                      <label htmlFor="whatsapp" className="block text-sm font-medium text-gray-900 mb-2">
                        Phone Number
                      </label>
                      <input
                        id="whatsapp"
                        type="tel"
                        inputMode="numeric"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                        placeholder="919876543210"
                        required
                      />
                      <p className="text-xs mt-1.5" style={{ color: '#4A5565' }}>
                        Please include your country code (e.g., 91XXXXXXXXXX for India)
                      </p>
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
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                        placeholder="Min. 6 characters"
                        required
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
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                        placeholder="Re-enter password"
                        required
                      />
                    </div>
                  </div>
                </div>

                {/* Error and Submit - Full Width */}
                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg mb-6">
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
                  {loading ? 'Sending OTP...' : 'Continue'}
                </button>
              </form>

              <div className="mt-8 text-center" style={{ color: '#4A5565' }}>
                <span className="text-sm">
                  Already have an account?{' '}
                  <Link to="/login" className="font-semibold transition" style={{ color: '#4A90E2' }}>
                    Login here
                  </Link>
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-gray-900 mb-2">
                  Verify Your WhatsApp
                </h2>
                <p style={{ color: '#4A5565' }} className="text-sm">
                  We've sent a 6-digit OTP to your WhatsApp<br />
                  <span className="font-semibold text-gray-900">+{phoneNumber.replace(/\D/g, '')}</span>
                </p>
              </div>

              <form onSubmit={handleVerifyOTP} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-900 mb-4 text-center">
                    Enter 6-Digit OTP
                  </label>
                  <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
                    {otp.map((digit, index) => (
                      <input
                        key={index}
                        ref={(el) => (otpInputsRef.current[index] = el)}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleOtpChange(index, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(index, e)}
                        className="w-12 h-12 text-center text-lg font-semibold border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0"
                        style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                      />
                    ))}
                  </div>
                </div>

                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg text-center">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || otp.join('').length !== 6}
                  className="w-full text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: '#4A90E2' }}
                  onMouseEnter={(e) => !loading && otp.join('').length === 6 && (e.currentTarget.style.backgroundColor = '#357ABD')}
                  onMouseLeave={(e) => !loading && (e.currentTarget.style.backgroundColor = '#4A90E2')}
                >
                  {loading ? 'Verifying...' : 'Verify & Create Account'}
                </button>

                <div className="text-center space-y-3">
                  <button
                    type="button"
                    onClick={handleResendOTP}
                    disabled={resendCooldown > 0 || loading}
                    className="block text-sm font-medium transition"
                    style={{ color: resendCooldown > 0 ? '#9CA3AF' : '#4A90E2' }}
                  >
                    {resendCooldown > 0 
                      ? `Resend OTP in ${resendCooldown}s` 
                      : 'Resend OTP'}
                  </button>
                  
                  <div>
                    <button
                      type="button"
                      onClick={handleBackToForm}
                      className="text-sm font-medium transition"
                      style={{ color: '#4A5565' }}
                    >
                      ← Change details
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
