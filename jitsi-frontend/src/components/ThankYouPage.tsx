import { debugLog } from '../utils/sanitization'

export default function ThankYouPage() {
  debugLog('ThankYouPage: Rendering')

  const handleCloseTab = () => {
    debugLog('ThankYouPage: Closing tab')
    // Try to close the tab
    window.close()
    // If window.close() doesn't work (opened directly, not via script),
    // show a message
    setTimeout(() => {
      alert('Please close this tab manually.')
    }, 100)
  }

  return (
    <div className="thank-you-container">
      <div className="thank-you-content">
        <div className="thank-you-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <path d="M8 12L11 15L16 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h1 className="thank-you-title">Meeting Ended</h1>
        <p className="thank-you-subtitle">Thank you for conducting the vMTB</p>
        <div className="thank-you-divider"></div>
        <p className="thank-you-message">
          Your meeting has ended successfully. We appreciate you using vMTB for your tumor board discussions.
        </p>
        <button className="thank-you-button" onClick={handleCloseTab}>
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Close Tab
        </button>
      </div>
    </div>
  )
}
