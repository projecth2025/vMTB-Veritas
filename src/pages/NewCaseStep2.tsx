import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useCaseCreation } from '../context/CaseCreationContext';
import { useIsMobile } from '../hooks/useMobile';
import { AlertCircle, FileText } from 'lucide-react';
import { VoiceRecorder } from '../components/VoiceRecorder';

export default function NewCaseStep2() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { step1Data, caseExplanation, setCaseExplanation } = useCaseCreation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  
  const [explanation, setExplanation] = useState(caseExplanation || '');

  // Auto-resize logic: maintains min height, expands as explanation grows up to ~20 lines, then scrolls
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const lineHeight = 24; // ~24px per line
    const minHeight = isMobile ? 300 : 400;
    const maxHeight = Math.max(minHeight, 20 * lineHeight + 24); // ~20 lines max (~504px)

    const scrollHeight = textarea.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

    textarea.style.height = `${targetHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [isMobile]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [explanation, adjustTextareaHeight]);

  const handleVoiceTranscription = (text: string) => {
    console.log(`[NewCaseStep2] handleVoiceTranscription called with text length: ${text.length}`);
    setExplanation((prev) => {
      const next = prev ? prev + '\n\n' + text : text;
      console.log(`[NewCaseStep2] Updated explanation state length: ${next.length}`);
      return next;
    });
  };

  // Redirect if no step1Data
  if (!step1Data) {
    navigate('/cases/new/step-1');
    return null;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCaseExplanation(explanation);
    navigate('/cases/review');
  };

  const handleBack = () => {
    setCaseExplanation(explanation);
    navigate('/cases/new/step-1');
  };

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <div className={isMobile ? 'mb-4' : 'mb-6'}>
          <h1 className={`font-bold ${isMobile ? 'text-xl' : 'text-2xl'}`} style={{ color: '#4A5565' }}>
            Explain Your Case
          </h1>
          <p className={`text-gray-600 mt-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>
            Step 2 of 3: Case Explanation (Optional)
          </p>
        </div>

        {/* Info Banner */}
        <div className={`mb-6 p-4 rounded-lg flex items-start gap-3 ${isMobile ? 'text-xs p-3' : 'text-sm'}`} style={{ backgroundColor: '#E8F4FD', borderColor: '#4A90E2', borderWidth: '1px' }}>
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#4A90E2' }} />
          <div style={{ color: '#4A5565' }}>
            <p className="font-medium mb-1">Explain your case in full detail</p>
            <p className="text-xs opacity-90">
              Type exactly as you would explain the case in a boardroom or a clinical meeting. Include all details you feel are relevant for understanding the case, patient history, test results, treatment timeline, and any specific questions you have.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5" style={{ color: '#4A90E2' }} />
                <label htmlFor="explanation" className="text-sm font-medium" style={{ color: '#4A5565' }}>
                  Case Explanation
                </label>
                <VoiceRecorder
                  onTranscriptionComplete={handleVoiceTranscription}
                  variant="explanation"
                  source="step2"
                  iconSize={18}
                />
              </div>
              <p className="text-xs text-gray-500">
                {explanation.length} characters
              </p>
            </div>

            <textarea
              ref={textareaRef}
              id="explanation"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 resize-none transition-all duration-150"
              style={{ 
                '--tw-ring-color': '#4A90E2',
                minHeight: isMobile ? '300px' : '400px',
                fontSize: '15px'
              } as React.CSSProperties}
              placeholder="Start typing your case explanation here...

Example:
Patient is a 65-year-old male with history of smoking presenting with persistent cough and weight loss over 3 months. CT scan shows 4cm mass in right upper lobe with mediastinal lymphadenopathy. Biopsy confirmed adenocarcinoma, PDL-1 expression 50%. Staging: T2N2M0 (Stage IIIA).

Previous treatments:
- Chemotherapy with carboplatin/pemetrexed (4 cycles)
- Partial response noted

Current concerns:
- Recent progression on imaging
- Patient experiencing increased dyspnea

Questions for the board:
- Should we consider immunotherapy at this stage?
- What are the options for surgical intervention?"
            />

            <div className="mt-3 flex items-start gap-2 text-xs text-gray-500">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <p>
                This explanation will be used by the AI to understand your case better and will be shared with the MTB members.
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className={`flex justify-between mt-6 ${isMobile ? 'flex-col-reverse gap-3' : ''}`}>
            <button
              type="button"
              onClick={handleBack}
              className={`px-6 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors ${isMobile ? 'w-full' : ''}`}
              style={{ color: '#4A5565' }}
            >
              Back
            </button>
            <button
              type="submit"
              className={`px-8 py-2.5 text-white rounded-lg hover:opacity-90 transition-opacity ${isMobile ? 'w-full' : ''}`}
              style={{ backgroundColor: '#4A90E2' }}
            >
              Continue to Review
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
