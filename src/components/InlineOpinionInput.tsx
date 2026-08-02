import { useState } from 'react';
import { Mic } from 'lucide-react';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';

interface InlineOpinionInputProps {
  onSubmit: (content: string) => Promise<void>;
  placeholder: string;
  variant?: 'card' | 'inline';
  submitLabel?: string;
}

export function InlineOpinionInput({ onSubmit, placeholder, variant = 'inline', submitLabel = 'Submit' }: InlineOpinionInputProps) {
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isMobile = useIsMobile();

  const handleSubmit = async () => {
    if (!content.trim()) return;

    setSubmitting(true);
    try {
      await onSubmit(content);
      setContent('');
    } catch (error: any) {
      console.error('Failed to submit opinion:', error);
      if (error?.code === '23505') {
        showToast.error('You have already submitted an opinion for this case. Please edit your existing opinion instead.');
      } else {
        showToast.error('Failed to submit opinion. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (variant === 'card') {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="relative">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={isMobile ? 3 : 4}
            className="w-full px-3 py-2.5 pr-10 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-sm bg-gray-50"
            placeholder={placeholder}
          />
          <button
            className="absolute right-3 top-3 text-gray-300 hover:text-blue-400 transition-colors"
            title="Voice input (coming soon)"
            type="button"
          >
            <Mic className="w-4 h-4" />
          </button>
        </div>
        <div className={`flex items-center justify-between mt-2.5`}>
          {!isMobile && <span className="text-[11px] text-gray-400">Ctrl + Enter to submit</span>}
          <button
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
            className="px-4 py-1.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
            style={{ backgroundColor: '#4A90E2' }}
          >
            {submitting ? 'Posting...' : submitLabel}
          </button>
        </div>
      </div>
    );
  }

  // Inline variant (compact, for question answers)
  return (
    <div className="mt-3">
      <div className="relative">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="w-full px-3 py-2 pr-10 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-sm bg-gray-50"
          placeholder={placeholder}
        />
        <button
          className="absolute right-3 top-2.5 text-gray-300 hover:text-blue-400 transition-colors"
          title="Voice input (coming soon)"
          type="button"
        >
          <Mic className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex justify-end mt-1.5">
        <button
          onClick={handleSubmit}
          disabled={submitting || !content.trim()}
          className="px-3 py-1 text-xs font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: '#4A90E2' }}
        >
          {submitting ? 'Posting...' : submitLabel}
        </button>
      </div>
    </div>
  );
}
