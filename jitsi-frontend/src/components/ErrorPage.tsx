import { debugLog } from '../utils/sanitization'

interface ErrorPageProps {
  error: string
  onRetry: () => void
  onBack: () => void
}

export default function ErrorPage({ error, onRetry, onBack }: ErrorPageProps) {
  debugLog(`ErrorPage: Rendering with error: ${error}`)

  return (
    <div className="error-container">
      <div className="error-content">
        <div className="error-icon">⚠️</div>
        <h2 className="error-title">Unable to Start Meeting</h2>
        <p className="error-message">{error}</p>
        <div className="error-buttons">
          <button className="btn-retry" onClick={onRetry}>
            Try Again
          </button>
          <button className="btn-back" onClick={onBack}>
            Back to App
          </button>
        </div>
        <p className="error-help">
          If the problem persists, please check your internet connection or contact support.
        </p>
      </div>
    </div>
  )
}
