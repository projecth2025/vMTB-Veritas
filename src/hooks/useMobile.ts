import { useState, useEffect } from 'react';

// Mobile breakpoint detection hook
// Targets phone-sized screens: max-width 640px AND max-height 900px
// This ensures tablets and larger devices use the desktop layout

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      // Mobile detection criteria:
      // - Width must be <= 640px (typical phone portrait width)
      // - OR width <= 900px AND height <= 500px (phone landscape)
      // This excludes tablets (768px+ width typically) and desktops
      const isPhonePortrait = width <= 640;
      const isPhoneLandscape = width <= 900 && height <= 500;
      
      setIsMobile(isPhonePortrait || isPhoneLandscape);
    };

    // Initial check
    checkMobile();

    // Listen for resize events
    window.addEventListener('resize', checkMobile);
    window.addEventListener('orientationchange', checkMobile);

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener('orientationchange', checkMobile);
    };
  }, []);

  return isMobile;
}

// Hook to check if device is in portrait mode
export function useIsPortrait(): boolean {
  const [isPortrait, setIsPortrait] = useState(true);

  useEffect(() => {
    const checkOrientation = () => {
      setIsPortrait(window.innerHeight > window.innerWidth);
    };

    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);

    return () => {
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
  }, []);

  return isPortrait;
}
