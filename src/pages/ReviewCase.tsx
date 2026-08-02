import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useCaseCreation } from '../context/CaseCreationContext';
import { useCases } from '../context/CasesContext';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useMobile';
import { X, Plus, AlertTriangle, FileText, AlertCircle } from 'lucide-react';
import { showToast } from '../utils/toast';

interface Document {
  id: string;
  name: string;
  size: string;
  type: 'Clinical' | 'Text';
  storagePath: string;
  mimeType?: string;
}

export default function ReviewCase() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const { step1Data, pendingFiles, caseExplanation, clearAll } = useCaseCreation();
  const { createCase, mtbs } = useCases();
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newQuestion, setNewQuestion] = useState('');
  const [questions, setQuestions] = useState<string[]>([]);
  const [selectedMtbIds, setSelectedMtbIds] = useState<string[]>([]);

  const isNavigatingAway = useRef(false);

  // Redirect if no step1Data
  useEffect(() => {
    if (!step1Data) {
      navigate('/cases/new/step-1');
    }
  }, [step1Data, navigate]);

  // Get only clinical files
  const clinicalFiles = useMemo(() => 
    pendingFiles.filter(f => f.type === 'Clinical'),
    [pendingFiles]
  );

  const addQuestion = () => {
    if (newQuestion.trim()) {
      setQuestions([...questions, newQuestion.trim()]);
      setNewQuestion('');
    }
  };

  const removeQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const toggleMtbSelection = (mtbId: string) => {
    setSelectedMtbIds(prev =>
      prev.includes(mtbId)
        ? prev.filter(id => id !== mtbId)
        : [...prev, mtbId]
    );
  };

  // Upload pipeline functions
  const getUploadConfiguration = async (): Promise<{
    requestId: string;
    uploadUrl: string;
    uploadPrefix: string;
    uploadFields: Record<string, string>;
  }> => {
    const response = await fetch('https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/get-upload-urls', {
      method: 'POST',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get upload configuration: ${errorText}`);
    }

    const data = await response.json();

    const parsedPayload = typeof data?.body === 'string'
      ? JSON.parse(data.body)
      : data?.body && typeof data.body === 'object'
        ? data.body
        : data;

    const normalizedRequestId =
      parsedPayload?.request_id ?? parsedPayload?.requestId ?? null;

    const normalizedUploadUrl =
      parsedPayload?.upload_url ?? parsedPayload?.uploadUrl ?? parsedPayload?.upload?.url ?? null;

    const normalizedUploadPrefix =
      parsedPayload?.upload_prefix ?? parsedPayload?.uploadPrefix ?? parsedPayload?.upload?.prefix ?? '';

    const normalizedUploadFields =
      parsedPayload?.fields ?? parsedPayload?.formFields ?? parsedPayload?.upload?.fields ?? {};

    if (
      !parsedPayload ||
      !normalizedRequestId ||
      !normalizedUploadUrl ||
      !normalizedUploadPrefix ||
      !normalizedUploadFields ||
      typeof normalizedUploadFields !== 'object'
    ) {
      throw new Error('Invalid upload configuration response from server');
    }

    return {
      requestId: normalizedRequestId,
      uploadUrl: normalizedUploadUrl,
      uploadPrefix: normalizedUploadPrefix,
      uploadFields: normalizedUploadFields,
    };
  };

  const uploadFilesToS3 = async (
    files: typeof clinicalFiles,
    uploadUrl: string,
    uploadPrefix: string,
    uploadFields: Record<string, string>
  ): Promise<void> => {
    for (const pendingFile of files) {
      const formData = new FormData();
      Object.entries(uploadFields).forEach(([fieldKey, value]) => {
        if (fieldKey !== 'key' && fieldKey !== 'acl') {
          formData.append(fieldKey, value);
        }
      });

      const serverProvidedKey = uploadFields.key;
      const fileKey = serverProvidedKey
        ? serverProvidedKey.replace('${filename}', pendingFile.name)
        : `${uploadPrefix}${pendingFile.name}`;

      formData.append('key', fileKey);
      formData.append('file', pendingFile.file);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to upload ${pendingFile.name}: ${errorText}`);
      }
    }
  };

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
      const additionalDataToSend = caseExplanation;

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
        storagePath: `${uploadPrefix}${pf.name}`,
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

      // Set flag and redirect as soon as case record is created
      isNavigatingAway.current = true;
      navigate('/my-cases');

      // ============================================================
      // STEP 3.5/4: Best-effort post-create operations
      // ============================================================
      try {
        if (additionalDataToSend) {
          console.log('💾 Step 3.5: Saving case explanation to Supabase...');
          const { supabase } = await import('../Supabase/client');

          const { error: docError } = await supabase
            .from('case_additional_documents')
            .insert({
              case_id: caseId,
              document_title: 'Case Explanation',
              document_data: additionalDataToSend,
            });

          if (docError) {
            console.error('Error saving case explanation:', docError);
          } else {
            console.log('✓ Case explanation saved to Supabase');
          }
        }

        console.log('⚙️  Step 4: Triggering backend processing...');
        await triggerBackendProcessing({
          requestId,
          caseId,
          additionalData: additionalDataToSend,
        });
        console.log('✓ Backend processing started');
      } catch (postCreateErr) {
        console.error('Post-create processing failed:', postCreateErr);
      }

      showToast.success('Case created successfully!');

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

  if (!step1Data) {
    return null; // Will redirect via useEffect
  }

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">
        <div className={isMobile ? 'mb-4' : 'mb-6'}>
          <h1 className={`font-bold ${isMobile ? 'text-xl' : 'text-2xl'}`} style={{ color: '#4A5565' }}>
            Review & Create Case
          </h1>
          <p className={`text-gray-600 mt-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>
            Step 3 of 3: Review your case details and create
          </p>
        </div>

        <div className={isMobile ? 'space-y-4' : 'space-y-5'}>
          {/* Patient & Case Details */}
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className={`flex ${isMobile ? 'flex-col gap-2' : 'items-start justify-between'} mb-4`}>
              <div>
                <h3 className={`font-semibold mb-1 ${isMobile ? 'text-base' : 'text-lg'}`} style={{ color: '#4A5565' }}>
                  Patient & Case Details
                </h3>
                <p className="text-xs text-gray-500">Basic information about the case</p>
              </div>
              <button
                onClick={() => navigate('/cases/new/step-1')}
                className="text-sm hover:underline"
                style={{ color: '#4A90E2' }}
              >
                Edit
              </button>
            </div>
            <div className={`grid gap-4 ${isMobile ? 'grid-cols-1 text-xs' : 'grid-cols-2 text-sm'}`}>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-gray-500 text-xs mb-1">Case Name</p>
                <p className="font-medium" style={{ color: '#4A5565' }}>{step1Data.caseName}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-gray-500 text-xs mb-1">Patient Name</p>
                <p className="font-medium" style={{ color: '#4A5565' }}>{step1Data.patientName || 'Anonymous'}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-gray-500 text-xs mb-1">Age / Sex</p>
                <p className="font-medium" style={{ color: '#4A5565' }}>{step1Data.age} / {step1Data.sex}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-gray-500 text-xs mb-1">Cancer Type</p>
                <p className="font-medium" style={{ color: '#4A5565' }}>{step1Data.cancerType}</p>
              </div>
            </div>
          </div>

          {/* Case Explanation */}
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5" style={{ color: '#4A90E2' }} />
                <div>
                  <h3 className={`font-semibold ${isMobile ? 'text-base' : 'text-lg'}`} style={{ color: '#4A5565' }}>
                    Case Explanation
                  </h3>
                  <p className="text-xs text-gray-500">Your detailed case description</p>
                </div>
              </div>
              <button
                onClick={() => navigate('/cases/new/step-2')}
                className="text-sm hover:underline"
                style={{ color: '#4A90E2' }}
              >
                Edit
              </button>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
              {caseExplanation?.trim() ? (
                <p className={`text-gray-800 whitespace-pre-wrap ${isMobile ? 'text-xs' : 'text-sm'}`}>
                  {caseExplanation}
                </p>
              ) : (
                <p className={`text-gray-500 italic ${isMobile ? 'text-xs' : 'text-sm'}`}>
                  No case explanation provided.
                </p>
              )}
            </div>
          </div>

          {/* Uploaded Documents */}
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className={`font-semibold ${isMobile ? 'text-base' : 'text-lg'}`} style={{ color: '#4A5565' }}>
                  Uploaded Documents
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {pendingFiles.length === 0 ? 'No documents uploaded' : `${pendingFiles.length} document(s)`}
                </p>
              </div>
              <button
                onClick={() => navigate('/cases/new/step-1')}
                className="text-sm hover:underline"
                style={{ color: '#4A90E2' }}
              >
                Edit
              </button>
            </div>
            {pendingFiles.length === 0 ? (
              <div className="bg-gray-50 rounded-lg p-6 text-center">
                <FileText className="w-10 h-10 mx-auto mb-2 text-gray-400" />
                <p className="text-sm text-gray-500">No documents uploaded</p>
              </div>
            ) : (
              <div className="space-y-2">
                {pendingFiles.map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-3 border border-gray-100">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <FileText className="w-5 h-5 text-gray-400 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium truncate ${isMobile ? 'text-xs' : 'text-sm'}`} style={{ color: '#4A5565' }}>
                          {doc.name}
                        </p>
                        <p className="text-xs text-gray-500">{doc.size}</p>
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full flex-shrink-0 ml-2 ${
                        doc.type === 'Clinical'
                          ? 'text-white'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                      style={doc.type === 'Clinical' ? { backgroundColor: '#4A90E2' } : {}}
                    >
                      {doc.type}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Questions for Experts */}
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className="mb-4">
              <h3 className={`font-semibold ${isMobile ? 'text-base' : 'text-lg'}`} style={{ color: '#4A5565' }}>
                Questions for Experts
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">Add specific questions you have about this case (optional)</p>
            </div>
            <div className="space-y-3">
              {questions.map((question, index) => (
                <div
                  key={index}
                  className="flex items-start justify-between bg-gray-50 rounded-lg p-3 border border-gray-100"
                >
                  <p className={`flex-1 ${isMobile ? 'text-xs' : 'text-sm'}`} style={{ color: '#4A5565' }}>
                    {index + 1}. {question}
                  </p>
                  <button
                    onClick={() => removeQuestion(index)}
                    className="text-red-500 hover:text-red-700 ml-2 flex-shrink-0"
                  >
                    <X className={isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                  </button>
                </div>
              ))}

              <div className={`flex ${isMobile ? 'flex-col gap-2' : 'gap-2'}`}>
                <input
                  type="text"
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && addQuestion()}
                  placeholder="Add a question for the board..."
                  className={`flex-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 ${isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2.5'}`}
                  style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                />
                <button
                  type="button"
                  onClick={addQuestion}
                  className={`flex items-center justify-center text-white rounded-lg hover:opacity-90 transition-opacity ${isMobile ? 'px-4 py-2 w-full' : 'px-6 py-2.5'}`}
                  style={{ backgroundColor: '#4A90E2' }}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  <span>Add</span>
                </button>
              </div>
            </div>
          </div>

          {/* Share with MTBs */}
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className="mb-4">
              <h3 className={`font-semibold ${isMobile ? 'text-base' : 'text-lg'}`} style={{ color: '#4A5565' }}>
                Share with MTBs
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">Select which MTBs should have access to this case (optional)</p>
            </div>
            {mtbs.length === 0 ? (
              <div className="bg-gray-50 rounded-lg p-6 text-center">
                <AlertCircle className="w-10 h-10 mx-auto mb-2 text-gray-400" />
                <p className="text-sm text-gray-500">You are not part of any MTBs yet</p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {mtbs.map(mtb => (
                    <label key={mtb.id} className={`flex items-center rounded-lg border hover:border-blue-300 cursor-pointer transition-colors ${
                      selectedMtbIds.includes(mtb.id) ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-gray-50'
                    } ${isMobile ? 'p-3' : 'p-4'}`}>
                      <input
                        type="checkbox"
                        checked={selectedMtbIds.includes(mtb.id)}
                        onChange={() => toggleMtbSelection(mtb.id)}
                        className="h-4 w-4 border-gray-300 rounded flex-shrink-0"
                        style={{ accentColor: '#4A90E2' }}
                      />
                      <div className="ml-3 min-w-0 flex-1">
                        <p className={`font-medium ${isMobile ? 'text-sm' : 'text-sm'}`} style={{ color: '#4A5565' }}>{mtb.name}</p>
                        <p className="text-xs text-gray-500">{mtb.experts} experts · {mtb.cases.length} cases</p>
                      </div>
                    </label>
                  ))}
                </div>
                {selectedMtbIds.length === 0 && (
                  <div className="mt-3 flex items-start gap-2 text-xs text-gray-500">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <p>No MTBs selected - case will be private</p>
                  </div>
                )}
              </>
            )}
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-red-700 text-sm flex-1">{error}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className={`flex ${isMobile ? 'flex-col-reverse gap-3' : 'justify-between'}`}>
            <button
              onClick={() => navigate('/cases/new/step-2')}
              disabled={loading}
              className={`border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 ${isMobile ? 'w-full py-2.5 text-sm' : 'px-6 py-2.5'}`}
              style={{ color: '#4A5565' }}
            >
              Back
            </button>
            <button
              onClick={handleCreateCase}
              disabled={loading}
              className={`text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ${isMobile ? 'w-full py-2.5 text-sm' : 'px-8 py-2.5'}`}
              style={{ backgroundColor: '#4A90E2' }}
            >
              {loading ? 'Creating Case...' : 'Create Case'}
            </button>
          </div>
        </div>
      </div>
    </Layout>
  );
}
