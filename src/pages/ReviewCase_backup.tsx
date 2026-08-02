import { useMemo, useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Document } from '../context/CasesContext';
import { useCases } from '../context/CasesContext';
import { useAuth } from '../context/AuthContext';
import { useCaseCreation, PendingFile } from '../context/CaseCreationContext';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';

export function ReviewCase() {
  const navigate = useNavigate();
  const { createCase, mtbs } = useCases();
  const { user } = useAuth();
  const { step1Data, pendingFiles, clearAll } = useCaseCreation();
  const isMobile = useIsMobile();
  const [questions, setQuestions] = useState<string[]>([]);
  const [newQuestion, setNewQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMtbIds, setSelectedMtbIds] = useState<string[]>([]);
  const isNavigatingAway = useRef(false);

  // Get text fragments from pending files (Text type)
  const textFragments = useMemo(() => 
    pendingFiles
      .filter(f => f.type === 'Text' && f.rawText)
      .map(f => f.rawText as string),
    [pendingFiles]
  );
  
  // Get clinical documents from pending files
  const clinicalFiles = useMemo(() => 
    pendingFiles.filter(f => f.type === 'Clinical'),
    [pendingFiles]
  );

  const additionalData = useMemo(() => textFragments.join('\n\n').trim(), [textFragments]);

  // Redirect if no step1 data (but not if we're intentionally navigating away)
  useEffect(() => {
    if (!step1Data && !isNavigatingAway.current) {
      navigate('/cases/new/step-1');
    }
  }, [step1Data, navigate]);

  // Return null while redirecting
  if (!step1Data && !isNavigatingAway.current) {
    return null;
  }

  const addQuestion = () => {
    if (newQuestion.trim()) {
      setQuestions([...questions, newQuestion]);
      setNewQuestion('');
    }
  };

  const removeQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const toggleMtbSelection = (id: string) => {
    setSelectedMtbIds(prev =>
      prev.includes(id) ? prev.filter(mtbId => mtbId !== id) : [...prev, id]
    );
  };

  // ============================================================
  // CORRECT 4-STEP CASE CREATION PIPELINE
  // ============================================================

  /**
   * Step 1: Get request_id and S3 upload configuration
   * Returns ONE set of credentials for ALL files
   */
  const getUploadConfiguration = async (): Promise<{
    requestId: string;
    uploadUrl: string;
    uploadPrefix: string;
    uploadFields: Record<string, string>;
  }> => {
    const response = await fetch('https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/get-upload-urls', {
      method: 'POST',
      // Empty POST request - no body
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get upload configuration: ${errorText}`);
    }

    const data = await response.json();

    return {
      requestId: data.request_id,
      uploadUrl: data.upload.url,
      uploadPrefix: data.upload.prefix,
      uploadFields: data.upload.fields || {},
    };
  };

  /**
   * Step 2: Upload files to S3 BEFORE creating case
   * Uses multipart/form-data with AWS form fields
   * ONE file per request (must loop for multiple files)
   */
  const uploadFilesToS3 = async (
    files: PendingFile[],
    uploadUrl: string,
    uploadPrefix: string,
    uploadFields: Record<string, string>
  ): Promise<void> => {
    for (const pendingFile of files) {
      const formData = new FormData();
      
      // Build S3 key: uploads/{request_id}/data/{filename}
      const fileKey = `${uploadPrefix}${pendingFile.name}`;
      
      // Add AWS-required form fields in correct order
      formData.append('key', fileKey);
      formData.append('x-amz-algorithm', uploadFields['x-amz-algorithm']);
      formData.append('x-amz-credential', uploadFields['x-amz-credential']);
      formData.append('x-amz-date', uploadFields['x-amz-date']);
      formData.append('x-amz-security-token', uploadFields['x-amz-security-token']);
      formData.append('policy', uploadFields['policy']);
      formData.append('x-amz-signature', uploadFields['x-amz-signature']);
      
      // Add file last
      formData.append('file', pendingFile.file);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`Failed to upload file "${pendingFile.name}" to S3: ${response.status}`);
      }

      console.log(`✓ Uploaded: ${pendingFile.name}`);
    }
  };

  /**
   * Step 3: Trigger backend processing
   * Calls /convert-doc2png to start the summarization pipeline
   */
  const triggerBackendProcessing = async (params: {
    requestId: string;
    caseId: string;
    additionalData: string;
  }): Promise<void> => {
    const response = await fetch('https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/trigger-converter-files-to-png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: params.requestId,
        case_id: params.caseId,
        additional_data: params.additionalData,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger backend processing: ${errorText}`);
    }

    const result = await response.json();
    console.log('Backend processing triggered:', result);
  };

  const clearCaseDraft = () => {
    clearAll();
  };

  const handleCreateCase = async () => {
    setError(null);
    setLoading(true);

    try {
      if (!step1Data || !user) {
        throw new Error('Missing required data. Please restart case creation.');
      }

      // Capture data BEFORE any operations
      const filesToUpload = [...clinicalFiles];
      const additionalDataToSend = additionalData;

      // ============================================================
      // STEP 1: Get request_id and upload configuration
      // ============================================================
      console.log('📡 Step 1: Getting upload configuration...');
      const { requestId, uploadUrl, uploadPrefix, uploadFields } = await getUploadConfiguration();
      console.log('✓ Got request_id:', requestId);

      // ============================================================
      // STEP 2: Upload ALL files to S3 (BEFORE creating case)
      // ============================================================
      if (filesToUpload.length > 0) {
        console.log('📤 Step 2: Uploading files to S3...');
        await uploadFilesToS3(filesToUpload, uploadUrl, uploadPrefix, uploadFields);
        console.log('✓ All files uploaded successfully');
      } else {
        console.log('⏭️  Step 2: No files to upload, skipping...');
      }

      // ============================================================
      // STEP 3: Create case in Supabase (AFTER files are uploaded)
      // ============================================================
      console.log('💾 Step 3: Creating case in Supabase...');
      
      // Convert pending files to Document format for metadata storage
      const documentsMetadata: Document[] = pendingFiles.map(pf => ({
        id: pf.id,
        name: pf.name,
        size: pf.size,
        type: pf.type,
        storagePath: `${uploadPrefix}data/${pf.name}`, // S3 path
        mimeType: pf.mimeType,
      }));

      const { caseId } = await createCase(
        {
          caseName: step1Data.caseName,
          patientName: step1Data.patientName,
          age: parseInt(step1Data.age, 10),
          sex: step1Data.sex,
          cancerType: step1Data.cancerType,
          summary: null,
          requestId: requestId,
        },
        documentsMetadata,
        questions,
        selectedMtbIds,
      );
      console.log('✓ Case created with ID:', caseId);

      // ============================================================
      // STEP 3.5: CRITICAL - Save additional data IMMEDIATELY if it exists
      // ============================================================
      if (additionalDataToSend) {
        console.log('💾 Step 3.5: Saving additional data to Supabase...');
        try {
          const { supabase } = await import('../Supabase/client');
          
          const { error: docError } = await supabase
            .from('case_additional_documents')
            .insert({
              case_id: caseId,
              document_title: 'Additional Data',
              document_data: additionalDataToSend,
            });
          
          if (docError) {
            console.error('Error saving additional document:', docError);
            throw new Error('Failed to save additional data');
          }
          
          console.log('✓ Additional data saved to Supabase');
        } catch (docErr) {
          console.error('Critical: Additional data save failed:', docErr);
          throw docErr; // Fail the entire case creation if additional data can't be saved
        }
      }

      // ============================================================
      // STEP 4: Trigger backend processing
      // ============================================================
      console.log('⚙️  Step 4: Triggering backend processing...');
      await triggerBackendProcessing({
        requestId,
        caseId,
        additionalData: additionalDataToSend,
      });
      console.log('✓ Backend processing started');

      // Set flag to prevent guard from redirecting to step-1
      isNavigatingAway.current = true;

      showToast.success('Case created successfully! Processing has started.');

      // Redirect to My Cases page
      navigate('/my-cases');

      // Clear context AFTER navigation is triggered
      clearCaseDraft();

    } catch (err: unknown) {
      console.error('Case creation failed:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to create case';
      setError(errorMessage);
      showToast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <div className={isMobile ? 'mb-4' : 'mb-6'}>
          <h1 className={`font-bold text-gray-900 ${isMobile ? 'text-xl' : 'text-2xl'}`}>Review & Create Case</h1>
          <p className={`text-gray-600 mt-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>We will create the case now and process documents asynchronously.</p>
        </div>

        <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
          {step1Data && (
            <div className={`bg-white rounded-lg shadow ${isMobile ? 'p-4' : 'p-6'}`}>
              <div className={`flex ${isMobile ? 'flex-col gap-2' : 'items-start justify-between'}`}>
                <div>
                  <h3 className={`font-medium text-gray-900 mb-1 ${isMobile ? 'text-base' : 'text-lg'}`}>Patient & Case Details</h3>
                  <p className={`text-gray-600 ${isMobile ? 'text-xs' : 'text-sm'}`}>Confirm the basic information before creating the case.</p>
                </div>
                <div className={`flex items-center text-amber-600 ${isMobile ? 'text-xs' : 'text-sm'}`}>
                  <AlertTriangle className={`mr-2 ${isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
                  Summary will be generated after processing.
                </div>
              </div>
              <div className={`mt-4 grid gap-4 ${isMobile ? 'grid-cols-1 text-xs' : 'grid-cols-2 text-sm'}`}>
                <div>
                  <p className="text-gray-600">Case Name</p>
                  <p className="font-medium text-gray-900">{step1Data.caseName}</p>
                </div>
                <div>
                  <p className="text-gray-600">Patient Name</p>
                  <p className="font-medium text-gray-900">{step1Data.patientName || 'Anonymous'}</p>
                </div>
                <div>
                  <p className="text-gray-600">Age / Sex</p>
                  <p className="font-medium text-gray-900">{step1Data.age} / {step1Data.sex}</p>
                </div>
                <div>
                  <p className="text-gray-600">Cancer Type</p>
                  <p className="font-medium text-gray-900">{step1Data.cancerType}</p>
                </div>
              </div>
            </div>
          )}

          <div className={`bg-white rounded-lg shadow ${isMobile ? 'p-4' : 'p-6'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-medium text-gray-900 ${isMobile ? 'text-base' : 'text-lg'}`}>Documents</h3>
              <button
                onClick={() => navigate('/cases/new/step-2')}
                className={`text-blue-600 hover:text-blue-700 ${isMobile ? 'text-xs' : 'text-sm'}`}
              >
                Edit uploads
              </button>
            </div>
            {pendingFiles.length === 0 ? (
              <p className={`text-gray-500 ${isMobile ? 'text-xs' : 'text-sm'}`}>No documents uploaded.</p>
            ) : (
              <div className="space-y-2">
                {pendingFiles.map((doc) => (
                  <div key={doc.id} className={`flex items-center justify-between bg-gray-50 rounded-md ${isMobile ? 'p-2' : 'p-3'}`}>
                    <div className="min-w-0 flex-1">
                      <p className={`font-medium text-gray-900 truncate ${isMobile ? 'text-xs' : 'text-sm'}`}>{doc.name}</p>
                      <p className="text-xs text-gray-500">{doc.size}</p>
                    </div>
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full flex-shrink-0 ml-2 ${
                        doc.type === 'Clinical'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {doc.type}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={`bg-white rounded-lg shadow ${isMobile ? 'p-4' : 'p-6'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-medium text-gray-900 ${isMobile ? 'text-base' : 'text-lg'}`}>Notes & Text Content</h3>
              <p className={`text-gray-500 ${isMobile ? 'text-xs hidden sm:block' : 'text-xs'}`}>These notes will be sent to backend as additional data.</p>
            </div>
            {textFragments.length === 0 ? (
              <p className={`text-gray-500 ${isMobile ? 'text-xs' : 'text-sm'}`}>No text notes captured.</p>
            ) : (
              <div className="space-y-3">
                {textFragments.map((text, idx) => (
                  <div key={idx} className={`bg-gray-50 rounded-md border border-gray-100 ${isMobile ? 'p-2' : 'p-3'}`}>
                    <p className="text-xs text-gray-500 mb-1">Note {idx + 1}</p>
                    <p className={`text-gray-800 whitespace-pre-wrap line-clamp-4 ${isMobile ? 'text-xs' : 'text-sm'}`}>{text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={`bg-white rounded-lg shadow ${isMobile ? 'p-4' : 'p-6'}`}>
            <h3 className={`font-medium text-gray-900 mb-3 ${isMobile ? 'text-base' : 'text-lg'}`}>Questions</h3>
            <div className="space-y-3">
              {questions.map((question, index) => (
                <div
                  key={index}
                  className={`flex items-start justify-between bg-gray-50 rounded-md ${isMobile ? 'p-2' : 'p-3'}`}
                >
                  <p className={`text-gray-900 flex-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>Question: {question}</p>
                  <button
                    onClick={() => removeQuestion(index)}
                    className="text-red-500 hover:text-red-700 ml-2 flex-shrink-0"
                  >
                    <X className={isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                  </button>
                </div>
              ))}

              <div className={`flex ${isMobile ? 'flex-col gap-2' : 'space-x-2'}`}>
                <input
                  type="text"
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && addQuestion()}
                  placeholder="Add a question for the board..."
                  className={`flex-1 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${isMobile ? 'px-3 py-2 text-sm' : 'px-3 py-2'}`}
                />
                <button
                  onClick={addQuestion}
                  className={`flex items-center justify-center bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors ${isMobile ? 'px-4 py-2 w-full' : 'space-x-1 px-4 py-2'}`}
                >
                  <Plus className="w-4 h-4" />
                  <span className={isMobile ? 'ml-1' : ''}>Add</span>
                </button>
              </div>
            </div>
          </div>

          <div className={`bg-white rounded-lg shadow ${isMobile ? 'p-4' : 'p-6'}`}>
            <div className={`flex ${isMobile ? 'flex-col gap-1' : 'items-center justify-between'} mb-3`}>
              <h3 className={`font-medium text-gray-900 ${isMobile ? 'text-base' : 'text-lg'}`}>Share with MTBs</h3>
              <p className="text-xs text-gray-500">(Optional - Leave empty to not share)</p>
            </div>
            {mtbs.length === 0 ? (
              <p className={`text-gray-500 ${isMobile ? 'text-xs' : 'text-sm'}`}>You are not part of any MTBs yet.</p>
            ) : (
              <>
                <div className="space-y-2">
                  {mtbs.map(mtb => (
                    <label key={mtb.id} className={`flex items-center space-x-3 rounded-md border border-gray-200 hover:border-blue-300 ${isMobile ? 'p-2' : 'p-3'}`}>
                      <input
                        type="checkbox"
                        checked={selectedMtbIds.includes(mtb.id)}
                        onChange={() => toggleMtbSelection(mtb.id)}
                        className="h-4 w-4 text-blue-600 border-gray-300 rounded flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium text-gray-900 ${isMobile ? 'text-sm' : 'text-sm'}`}>{mtb.name}</p>
                        <p className="text-xs text-gray-500">{mtb.experts} experts · {mtb.cases.length} cases</p>
                      </div>
                    </label>
                  ))}
                </div>
                {selectedMtbIds.length === 0 && (
                  <p className="text-xs text-gray-500 mt-3">ℹ️ No MTBs selected - case will be private</p>
                )}
              </>
            )}
          </div>

          {error && <div className={`text-red-600 ${isMobile ? 'text-xs' : 'text-sm'}`}>{error}</div>}

          <div className={`flex ${isMobile ? 'flex-col-reverse gap-2' : 'justify-end space-x-3'}`}>
            <button
              onClick={() => navigate('/cases/new/step-2')}
              disabled={loading}
              className={`border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 ${isMobile ? 'w-full py-2.5 text-sm' : 'px-4 py-2'}`}
            >
              Back
            </button>
            <button
              onClick={handleCreateCase}
              disabled={loading}
              className={`bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isMobile ? 'w-full py-2.5 text-sm' : 'px-6 py-2'}`}
            >
              {loading ? 'Creating...' : 'Create Case'}
            </button>
          </div>
        </div>
      </div>
    </Layout>
  );
}
