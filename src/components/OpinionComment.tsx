import { useState } from 'react';
import { Reply, ThumbsUp } from 'lucide-react';
import { Opinion } from '../context/CasesContext';
import { showToast } from '../utils/toast';

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface OpinionCommentProps {
  opinion: Opinion;
  allOpinions: Opinion[];
  depth: number;
  onReply: (parentId: string, questionId: string | null, content: string) => Promise<void>;
  currentUserId: string | undefined;
  canReply: boolean;
  ownerId?: string;
  compact?: boolean;
}

export function OpinionComment({
  opinion,
  allOpinions,
  depth,
  onReply,
  currentUserId,
  canReply,
  ownerId,
  compact,
}: OpinionCommentProps) {
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [liked, setLiked] = useState(false);

  const isOwnOpinion = opinion.authorUserId === currentUserId;
  const isCaseOwner = opinion.authorUserId === ownerId;

  const authorLabel = isOwnOpinion ? 'You' : isCaseOwner ? 'Case Owner' : `Anonymous ${opinion.authorUserId?.slice(-2) || ''}`;

  // Get replies to this opinion
  const replies = allOpinions
    .filter(o => o.parentId === opinion.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const handleSubmitReply = async () => {
    if (!replyText.trim()) return;
    setSubmitting(true);
    try {
      await onReply(opinion.id, opinion.questionId, replyText);
      setReplyText('');
      setShowReplyInput(false);
    } catch (error: any) {
      console.error('Failed to submit reply:', error);
      if (error?.code === '23505') {
        showToast.error('You have already submitted an opinion for this case. Please edit your existing opinion instead.');
      } else {
        showToast.error('Failed to submit reply. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const marginLeft = depth > 0 ? 20 : 0;

  return (
    <div style={{ marginLeft: `${marginLeft}px` }}>
      <div className={`${compact ? 'py-2' : depth === 0 ? 'bg-white rounded-xl shadow-sm border border-gray-100 p-4' : 'pl-4 py-3 border-l-2 border-blue-100'}`}>
        {/* Author and timestamp */}
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
            <span className="text-[10px] font-bold text-blue-600">{authorLabel.charAt(0).toUpperCase()}</span>
          </div>
          <span className="text-sm font-semibold text-gray-900">{authorLabel}</span>
          {isCaseOwner && !isOwnOpinion && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-blue-50 text-blue-600">Owner</span>
          )}
          <span className="text-xs text-gray-400">{timeAgo(opinion.createdAt)}</span>
        </div>

        {/* Content */}
        <p className={`text-gray-700 whitespace-pre-wrap leading-relaxed ${compact ? 'text-xs' : 'text-sm'} ml-8`}>{opinion.content}</p>

        {/* Actions */}
        <div className="flex items-center gap-4 mt-2 ml-8">
          <button
            onClick={() => setLiked(!liked)}
            className={`flex items-center gap-1 text-xs transition-colors ${liked ? 'text-blue-600' : 'text-gray-400 hover:text-blue-500'}`}
          >
            <ThumbsUp className="w-3 h-3" />
            <span>Like</span>
          </button>
          {canReply && (
            <button
              onClick={() => setShowReplyInput(!showReplyInput)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-500 transition-colors"
            >
              <Reply className="w-3 h-3" />
              <span>Reply</span>
            </button>
          )}
          {replies.length > 0 && (
            <span className="text-xs text-gray-400">
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </span>
          )}
        </div>

        {/* Inline Reply Input */}
        {showReplyInput && (
          <div className="mt-3 ml-8 space-y-2">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none bg-gray-50"
              placeholder="Write your reply..."
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleSubmitReply}
                disabled={submitting || !replyText.trim()}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#4A90E2' }}
              >
                {submitting ? 'Posting...' : 'Reply'}
              </button>
              <button
                onClick={() => { setShowReplyInput(false); setReplyText(''); }}
                className="px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Nested Replies — inside the card so they're contained */}
        {replies.length > 0 && (
          <div className="mt-3">
            {replies.map((reply) => (
              <OpinionComment
                key={reply.id}
                opinion={reply}
                allOpinions={allOpinions}
                depth={depth + 1}
                onReply={onReply}
                currentUserId={currentUserId}
                canReply={canReply}
                ownerId={ownerId}
                compact={compact}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
