import toast from 'react-hot-toast';

const toastConfig = {
  style: {
    background: '#fff',
    color: '#1f2937',
    padding: '16px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
  },
  success: {
    duration: 3000,
    iconTheme: {
      primary: '#3b82f6',
      secondary: '#fff',
    },
  },
  error: {
    duration: 4000,
    iconTheme: {
      primary: '#ef4444',
      secondary: '#fff',
    },
  },
};

export const showToast = {
  success: (message: string) => {
    toast.success(message, {
      style: toastConfig.style,
      iconTheme: toastConfig.success.iconTheme,
      duration: toastConfig.success.duration,
    });
  },
  
  error: (message: string) => {
    toast.error(message, {
      style: toastConfig.style,
      iconTheme: toastConfig.error.iconTheme,
      duration: toastConfig.error.duration,
    });
  },
  
  warning: (message: string) => {
    toast(message, {
      icon: '⚠️',
      style: {
        ...toastConfig.style,
        borderColor: '#f59e0b',
      },
      duration: 3500,
    });
  },
  
  info: (message: string) => {
    toast(message, {
      icon: 'ℹ️',
      style: {
        ...toastConfig.style,
        borderColor: '#3b82f6',
      },
      duration: 3000,
    });
  },
};
