import { ReactNode, useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LogOut, MessageSquare, Settings, ChevronDown, Bell, Upload } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Modal } from './Modal';
import { MobileNav } from './MobileNav';
import { useIsMobile } from '../hooks/useMobile';
import { supabase } from '../Supabase/client';

interface LayoutProps {
  children: ReactNode;
  wide?: boolean;
}

export function Layout({ children, wide = false }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout, user } = useAuth();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showNotificationDropdown, setShowNotificationDropdown] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Profile form state
  const [profileName, setProfileName] = useState(user?.name || '');
  const [profileProfession, setProfileProfession] = useState('');
  const [profileHospital, setProfileHospital] = useState('');
  const [profileWhatsapp, setProfileWhatsapp] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // Feedback form state
  const [feedbackType, setFeedbackType] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setShowNotificationDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load profile data when modal opens
  useEffect(() => {
    const loadProfile = async () => {
      if (showProfileModal && user?.id) {
        const { data } = await supabase
          .from('profiles')
          .select('full_name, profession, hospital, whatsapp_number')
          .eq('id', user.id)
          .single();
        if (data) {
          setProfileName(data.full_name || '');
          setProfileProfession(data.profession || '');
          setProfileHospital(data.hospital || '');
          setProfileWhatsapp(data.whatsapp_number || '');
        }
      }
    };
    loadProfile();
  }, [showProfileModal, user?.id]);

  // Validation for required profile fields
  const isProfileValid = profileName.trim() && profileProfession.trim() && profileHospital.trim() && profileWhatsapp.trim();
  const [profileError, setProfileError] = useState<string | null>(null);

  const handleSaveProfile = async () => {
    if (!user?.id) return;
    
    // Validate required fields
    if (!profileName.trim()) {
      setProfileError('Full name is required');
      return;
    }
    if (!profileProfession.trim()) {
      setProfileError('Profession is required');
      return;
    }
    if (!profileHospital.trim()) {
      setProfileError('Hospital/Institution is required');
      return;
    }
    if (!profileWhatsapp.trim()) {
      setProfileError('WhatsApp number is required');
      return;
    }
    
    setProfileError(null);
    setProfileLoading(true);
    try {
      await supabase
        .from('profiles')
        .update({
          full_name: profileName.trim(),
          profession: profileProfession.trim(),
          hospital: profileHospital.trim(),
          whatsapp_number: profileWhatsapp.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id);
      setProfileSaved(true);
      setTimeout(() => {
        setProfileSaved(false);
        setShowProfileModal(false);
      }, 1500);
    } catch (err) {
      console.error('Failed to save profile:', err);
      setProfileError('Failed to save profile. Please try again.');
    } finally {
      setProfileLoading(false);
    }
  };

  const handleSendFeedback = async () => {
    if (!user?.id || !feedbackText.trim() || !feedbackType) return;
    setFeedbackLoading(true);
    try {
      // Concatenate feedbackType with feedbackText
      const fullFeedback = `${feedbackType} - ${feedbackText.trim()}`;
      await supabase.from('feedback').insert({
        user_id: user.id,
        content: fullFeedback,
      });
      setFeedbackSent(true);
      setFeedbackText('');
      setFeedbackType('');
      setTimeout(() => {
        setFeedbackSent(false);
        setShowFeedbackModal(false);
      }, 1500);
    } catch (err) {
      console.error('Failed to send feedback:', err);
    } finally {
      setFeedbackLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const isActive = (path: string) => location.pathname === path;

  const greetingText = (() => {
    const emailPrefix = user?.email ? user.email.split('@')[0] : '';
    const rawName = (user?.name && user.name.trim()) || emailPrefix;
    if (!rawName) return '';
    const formatted = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    return `Hello, Dr ${formatted}`;
  })();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile Navigation - Only visible on mobile screens */}
      {isMobile && (
        <MobileNav
          onProfileClick={() => setShowProfileModal(true)}
          onFeedbackClick={() => setShowFeedbackModal(true)}
        />
      )}

      {/* Desktop Navigation - Hidden on mobile screens */}
      <nav className="desktop-nav bg-white border-b border-gray-200 sticky top-0 z-50 w-full">
        <div className="w-full px-4 lg:px-6">
          <div className="flex justify-between items-center h-12">
            <div className="flex items-center space-x-8">
              <div className="flex items-center space-x-2 cursor-pointer" onClick={() => navigate('/my-cases')}>
                <img 
                  src="https://i.ibb.co/vxP6Cs3c/logo.png" 
                  alt="VMTB" 
                  className="h-10 w-auto"
                />
                <span className="text-xxl font-semibold text-gray-900">vMTB</span>
              </div>

              <div className="flex space-x-1">
                <button
                  onClick={() => navigate('/my-cases')}
                  className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                    isActive('/my-cases')
                      ? 'text-gray-900'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  My Cases
                  {isActive('/my-cases') && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#4A90E2' }}></div>
                  )}
                </button>
                <button
                  onClick={() => navigate('/mtbs')}
                  className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                    isActive('/mtbs')
                      ? 'text-gray-900'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  MTBs
                  {isActive('/mtbs') && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#4A90E2' }}></div>
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="text-sm" style={{ color: '#4A5565' }}>{greetingText}</div>
              
              {/* Notification Icon */}
              <div className="relative" ref={notificationRef}>
                <button
                  onClick={() => setShowNotificationDropdown(!showNotificationDropdown)}
                  className="p-2 rounded-full hover:bg-gray-100 transition-colors relative"
                >
                  <Bell className="w-5 h-5" style={{ color: '#4A5565' }} />
                </button>
                
                {showNotificationDropdown && (
                  <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-gray-200 p-4 z-50">
                    <div className="text-center">
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 mb-3">
                        <Bell className="w-6 h-6" style={{ color: '#4A90E2' }} />
                      </div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-2">Coming Soon!</h3>
                      <p className="text-sm" style={{ color: '#4A5565' }}>
                        We're working on this feature. Notifications will be available soon.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Profile Dropdown */}
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowDropdown(!showDropdown)}
                  className="flex items-center space-x-2 p-1 rounded-full hover:bg-gray-100 transition-colors"
                >
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm" style={{ backgroundColor: '#4A90E2' }}>
                    {user?.name?.charAt(0).toUpperCase() || user?.email?.charAt(0).toUpperCase() || 'U'}
                  </div>
                  <ChevronDown className={`w-4 h-4 transition-transform ${showDropdown ? 'rotate-180' : ''}`} style={{ color: '#4A5565' }} />
                </button>

                {showDropdown && (
                  <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1.5 z-50">
                    <button
                      onClick={() => {
                        setShowDropdown(false);
                        setShowProfileModal(true);
                      }}
                      className="flex items-center space-x-3 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <Settings className="w-4 h-4" />
                      <span>Profile</span>
                    </button>
                    <button
                      onClick={() => {
                        setShowDropdown(false);
                        setShowFeedbackModal(true);
                      }}
                      className="flex items-center space-x-3 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span>Feedback</span>
                    </button>
                    <hr className="my-1.5 border-gray-100" />
                    <button
                      onClick={handleLogout}
                      className="flex items-center space-x-3 w-full px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Logout</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

      <main className={`${wide ? 'max-w-[90%]' : 'max-w-7xl'} mx-auto px-4 sm:px-6 lg:px-8 py-8 ${isMobile ? 'mobile-main-content' : ''}`}>
        {children}
      </main>

      {/* Profile Modal */}
      <Modal
        isOpen={showProfileModal}
        onClose={() => {
          setShowProfileModal(false);
          setProfileError(null);
        }}
        title="Edit Profile"
      >
        <div className="space-y-5">
          {/* Profile Picture Section */}
          <div className="flex items-center space-x-4 pb-5 border-b border-gray-200">
            <div className="w-20 h-20 rounded-full flex items-center justify-center text-white font-bold text-2xl" style={{ backgroundColor: '#4A90E2' }}>
              {user?.name?.charAt(0).toUpperCase() || user?.email?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="flex-1">
              <button
                className="flex items-center space-x-2 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Upload className="w-4 h-4" />
                <span>Upload Photo</span>
              </button>
              <p className="text-xs text-gray-500 mt-1.5">JPG, PNG or GIF (max 2MB)</p>
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">Email Address</label>
            <input
              type="email"
              value={user?.email || ''}
              disabled
              className="w-full px-4 py-2.5 border border-gray-200 rounded-lg bg-gray-50 text-gray-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={profileName}
              onChange={(e) => {
                setProfileName(e.target.value);
                setProfileError(null);
              }}
              className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 text-sm transition ${
                !profileName.trim() && profileError ? 'border-red-300' : 'border-gray-300'
              }`}
              style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
              placeholder="Dr. John Doe"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Profession <span className="text-red-500">*</span>
            </label>
            <select
              value={profileProfession}
              onChange={(e) => {
                setProfileProfession(e.target.value);
                setProfileError(null);
              }}
              className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 text-sm transition ${
                !profileProfession.trim() && profileError ? 'border-red-300' : 'border-gray-300'
              }`}
              style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
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
            <p className="text-xs mt-1.5" style={{ color: '#4A5565' }}>If not listed, please mention in feedback</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Hospital / Institution <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={profileHospital}
              onChange={(e) => {
                setProfileHospital(e.target.value);
                setProfileError(null);
              }}
              className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 text-sm transition ${
                !profileHospital.trim() && profileError ? 'border-red-300' : 'border-gray-300'
              }`}
              style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
              placeholder="City Cancer Hospital"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              WhatsApp Number <span className="text-red-500">*</span>
            </label>
            <input
              type="tel"
              value={profileWhatsapp}
              onChange={(e) => {
                setProfileWhatsapp(e.target.value);
                setProfileError(null);
              }}
              className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 text-sm transition ${
                !profileWhatsapp.trim() && profileError ? 'border-red-300' : 'border-gray-300'
              }`}
              style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
              placeholder="e.g., +90 5XXXXXXXXX"
            />
            <p className="text-xs mt-1.5" style={{ color: '#4A5565' }}>Required for meeting notifications</p>
          </div>
          
          {profileError && (
            <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-200">
              {profileError}
            </div>
          )}
          
          <div className="flex justify-end space-x-3 pt-4">
            <button
              onClick={() => {
                setShowProfileModal(false);
                setProfileError(null);
              }}
              className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveProfile}
              disabled={profileLoading || !isProfileValid}
              className="px-5 py-2.5 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#4A90E2' }}
              onMouseEnter={(e) => !(profileLoading || !isProfileValid) && (e.currentTarget.style.backgroundColor = '#357ABD')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#4A90E2')}
            >
              {profileLoading ? 'Saving...' : profileSaved ? 'Saved!' : 'Save Changes'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Feedback Modal */}
      <Modal
        isOpen={showFeedbackModal}
        onClose={() => {
          setShowFeedbackModal(false);
          setFeedbackType('');
          setFeedbackText('');
        }}
        title="Send Feedback"
        size="large"
      >
        <div className="space-y-5">
          <p className="text-sm" style={{ color: '#4A5565' }}>
            We'd love to hear from you! Share your feedback, suggestions, or report any issues.
          </p>
          
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Feedback Type <span className="text-red-500">*</span>
            </label>
            <select
              value={feedbackType}
              onChange={(e) => setFeedbackType(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 text-sm transition"
              style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
            >
              <option value="">Select feedback type</option>
              <option value="Bug Report">Bug Report</option>
              <option value="Feature Request">Feature Request</option>
              <option value="Suggestion">Suggestion</option>
              <option value="General Feedback">General Feedback</option>
              <option value="Other">Other</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Your Feedback <span className="text-red-500">*</span>
            </label>
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              rows={8}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 text-sm transition"
              style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
              placeholder="Please share your thoughts..."
            />
          </div>
          
          <div className="flex justify-end space-x-3 pt-4">
            <button
              onClick={() => {
                setShowFeedbackModal(false);
                setFeedbackType('');
                setFeedbackText('');
              }}
              className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSendFeedback}
              disabled={feedbackLoading || !feedbackText.trim() || !feedbackType}
              className="px-5 py-2.5 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#4A90E2' }}
              onMouseEnter={(e) => !(feedbackLoading || !feedbackText.trim() || !feedbackType) && (e.currentTarget.style.backgroundColor = '#357ABD')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#4A90E2')}
            >
              {feedbackLoading ? 'Sending...' : feedbackSent ? 'Sent!' : 'Send Feedback'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
