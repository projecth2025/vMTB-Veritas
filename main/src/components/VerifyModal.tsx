import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

interface VerifyModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

export function VerifyModal({ isOpen, onConfirm, onCancel, isLoading }: VerifyModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title="Verify Case Summary">
      <div className="space-y-5">
        {/* Warning Icon */}
        <div className="flex justify-center">
          <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-orange-500" />
          </div>
        </div>

        {/* Warning Text */}
        <p style={{ color: '#4A5565' }} className="text-sm text-center">
          Once you verify this case summary, it will be:
        </p>

        {/* Bullet List */}
        <ul className="space-y-2">
          <li className="flex items-start gap-3">
            <span className="text-blue-500 font-bold mt-0.5">•</span>
            <span style={{ color: '#4A5565' }} className="text-sm">
              Shared with selected MTBs
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-blue-500 font-bold mt-0.5">•</span>
            <span style={{ color: '#4A5565' }} className="text-sm">
              Visible to other MTB members and experts
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-blue-500 font-bold mt-0.5">•</span>
            <span style={{ color: '#4A5565' }} className="text-sm">
              No longer editable
            </span>
          </li>
        </ul>

        {/* Footer Note */}
        <p style={{ color: '#4A5565' }} className="text-xs text-center">
          Make sure the summary is accurate before confirming. This action cannot be undone.
        </p>

        {/* Actions */}
        <div className="flex gap-3 justify-end pt-2 border-t border-gray-100">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
            style={{ backgroundColor: '#4A90E2' }}
          >
            {isLoading ? 'Verifying...' : 'Verify & Share'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
