import { debugLog } from '../utils/sanitization'

interface MeetingLoaderProps {
  elapsedSeconds: number
}

export default function MeetingLoader({ elapsedSeconds }: MeetingLoaderProps) {
  debugLog(`[LOADER] Rendering (${elapsedSeconds}s)`)

  return (
    <div className="loader-container" style={{ minHeight: '100vh', width: '100%' }}>
      <div className="loader-content">
        <div className="spinner"></div>
        <h2 className="loader-title">Initializing Meeting</h2>
        <p className="loader-status">
          <span className="status-badge">Connecting to server...</span>
        </p>
        <p className="loader-time">
          {elapsedSeconds} second{elapsedSeconds !== 1 ? 's' : ''} elapsed
        </p>
        <p className="loader-info">Please wait while we set up your meeting room</p>
      </div>
    </div>
  )
}
