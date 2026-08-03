import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PasswordStrength } from './PasswordStrength';

interface PasswordInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  showStrength?: boolean;
}

export function PasswordInput({
  id,
  value,
  onChange,
  placeholder = 'Enter password',
  required = false,
  disabled = false,
  className = '',
  style,
  showStrength = false,
  onFocus,
  onBlur,
  ...props
}: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    if (onFocus) onFocus(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    if (onBlur) onBlur(e);
  };

  return (
    <div className="w-full">
      <div className="relative w-full">
        <input
          id={id}
          type={showPassword ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className={`w-full px-4 py-2.5 pr-11 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm ${className}`}
          style={{ '--tw-ring-color': '#4A90E2', fontSize: '16px', ...style } as React.CSSProperties}
          {...props}
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          disabled={disabled}
          tabIndex={-1}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none p-1 rounded transition flex items-center justify-center"
          aria-label={showPassword ? 'Hide password' : 'Show password'}
        >
          {showPassword ? (
            <EyeOff className="w-5 h-5" />
          ) : (
            <Eye className="w-5 h-5" />
          )}
        </button>
      </div>

      {showStrength && (
        <PasswordStrength password={value} isFocused={isFocused} />
      )}
    </div>
  );
}
