import { useState, useEffect, useRef, useCallback } from 'react';
import { FileText, AlertTriangle, Loader2, Edit, Save, Trash2, Upload, Plus, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Case } from '../context/CasesContext';
import { useCases } from '../context/CasesContext';
import { Modal } from './Modal';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';

interface ReportsProps {
  caseData: Case;
  isOwner: boolean;
}

interface ReportFile {
  filename: string;
  url: string;
  id?: string;
  pending?: boolean;
  file?: File;
}

interface ReportsApiResponse {
  files: ReportFile[];
}

interface AdditionalDocument {
  title: string;
  content: string;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Removes the fixed prefix pattern ANO_NNCMFAGSSS_<number>_ from report filenames
 * @param filename - The original filename
 * @returns The filename without the prefix
 */
function stripReportPrefix(filename: string): string {
  // Pattern: ANO_NNCMFAGSSS_<any number>_
  const prefixPattern = /^ANO_NNCMFAGSSS_\d+_/;
  return filename.replace(prefixPattern, '');
}

// ============================================================
// PLACEHOLDER API FUNCTIONS (TO BE IMPLEMENTED LATER)
// ============================================================

async function updateAdditionalDocument(data: AdditionalDocument, caseId: string) {
  const { supabase } = await import('../Supabase/client');
  
  const { data: upsertData, error } = await supabase
      .from('case_additional_documents')
      .upsert(
        {
          case_id: caseId,
          document_title: data.title,
          document_data: data.content,
        },
        {
          onConflict: 'case_id',
        }
      )
      .select();
  
  if (error) {
    console.error('Error upserting additional document:', error);
    throw error;
  }
  
  console.log('✓ Additional document saved to Supabase', upsertData);
  return Promise.resolve();
}

async function deleteReportsForRequest(requestId: string, filenames: string[]) {
  const response = await fetch('https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/delete-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      delete_files: filenames,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Delete failed: ${text}`);
  }
}

async function getUploadConfigForExistingRequest(requestId: string): Promise<{
  uploadUrl: string;
  uploadPrefix: string;
  uploadFields: Record<string, string>;
}> {
  const response = await fetch('https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/get-upload-urls_4_new_documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get upload config: ${text}`);
  }

  const data = await response.json();
  return {
    uploadUrl: data.upload.url,
    uploadPrefix: data.upload.prefix,
    uploadFields: data.upload.fields || {},
  };
}

async function uploadFilesToS3(files: File[], uploadUrl: string, uploadPrefix: string, uploadFields: Record<string, string>) {
  const requiredFields = ['x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-security-token', 'policy', 'x-amz-signature'];
  requiredFields.forEach((field) => {
    if (!uploadFields[field]) {
      throw new Error(`Missing upload field: ${field}`);
    }
  });

  for (const file of files) {
    const formData = new FormData();

    // Build key; prefer server-provided template, fallback to prefix
    const keyTemplate = uploadFields.key || `${uploadPrefix}${file.name}`;
    const key = keyTemplate.replace('${filename}', file.name);

    // Append all server-provided fields, replacing filename placeholder where needed
    formData.append('key', key);
    Object.entries(uploadFields).forEach(([field, value]) => {
      if (field === 'key' || field === 'acl') return; // do not send acl unless explicitly required by policy
      const hydrated = value.replace?.('${filename}', file.name) ?? value;
      formData.append(field, hydrated);
    });

    // Add file last
    formData.append('file', file);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`Failed to upload ${file.name}: ${text}`);
    }

    console.log('✓ Uploaded to S3:', file.name);
  }
}

async function triggerReprocessing(requestId: string, caseId: string, additionalData: string) {
  // Mirror create-case flow endpoint (CORS-enabled)
  const response = await fetch('https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/trigger-converter-files-to-png', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, case_id: caseId, additional_data: additionalData }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Converter failed: ${text}`);
  }
}

async function markCaseProcessing(caseId: string) {
  const { supabase } = await import('../Supabase/client');
  const { error } = await supabase
    .from('cases')
    .update({ summary_status: 'processing', report_status: 'not_ready' })
    .eq('id', caseId);

  if (error) {
    throw new Error(`Failed to update case status: ${error.message}`);
  }
}

async function fetchAdditionalDocument(caseId: string): Promise<AdditionalDocument | null> {
  const { supabase } = await import('../Supabase/client');
  
  // Don't use .single() - it throws 406 if no rows found
  // Use .maybeSingle() instead, which returns null if no rows
  const { data, error } = await supabase
    .from('case_additional_documents')
    .select('document_title, document_data')
    .eq('case_id', caseId)
    .maybeSingle();
  
  if (error) {
    console.error('Error fetching additional document:', error);
    return null; // Don't throw, just return null
  }
  
  if (!data) {
    return null; // No document found
  }
  
  return {
    title: data.document_title,
    content: data.document_data,
  };
}

export function Reports({ caseData, isOwner }: ReportsProps) {
  // Mobile detection
  const isMobile = useIsMobile();
  
  // Reports state
  const [reports, setReports] = useState<ReportFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // Edit mode state
  const [isEditMode, setIsEditMode] = useState(false);
  const [filesToDelete, setFilesToDelete] = useState<string[]>([]); // filenames only
  const [filesToUpload, setFilesToUpload] = useState<File[]>([]);
  const [additionalDataDraft, setAdditionalDataDraft] = useState<AdditionalDocument | null>(null);
  
  // Additional document state
  const [additionalDocument, setAdditionalDocument] = useState<AdditionalDocument | null>(null);
  const [showAdditionalDataModal, setShowAdditionalDataModal] = useState(false);
  const [additionalDataTitle, setAdditionalDataTitle] = useState('');
  const [additionalDataContent, setAdditionalDataContent] = useState('');

  // Upload modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Full-screen viewer state
  const [viewerReport, setViewerReport] = useState<ReportFile | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);

  // PDF thumbnail cache
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const thumbnailsRequested = useRef<Set<string>>(new Set());

  const isImageFile = useCallback((filename: string) => {
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename);
  }, []);

  // Object URL cache for pending files
  const objectUrlMap = useRef<Map<File, string>>(new Map());

  const getObjectUrl = useCallback((file: File) => {
    const existing = objectUrlMap.current.get(file);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    objectUrlMap.current.set(file, url);
    return url;
  }, []);

  // Cleanup revoked URLs when files are removed or component unmounts
  useEffect(() => {
    return () => {
      objectUrlMap.current.forEach(url => URL.revokeObjectURL(url));
      objectUrlMap.current.clear();
    };
  }, []);

  useEffect(() => {
    // Revoke URLs for files no longer in queue
    const activeFiles = new Set(filesToUpload);
    objectUrlMap.current.forEach((url, file) => {
      if (!activeFiles.has(file)) {
        URL.revokeObjectURL(url);
        objectUrlMap.current.delete(file);
      }
    });
  }, [filesToUpload]);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { verifyReport } = useCases();

  const loadReports = useCallback(async () => {
    const status = caseData.reportStatus;

    if (status !== 'unverified' && status !== 'verified' && status !== 'not_ready') {
      return;
    }

    if (!caseData.requestId || caseData.requestId.trim() === '') {
      setError('Oh sorry, but your reports are not available.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/get-reports?request_id=${caseData.requestId}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch reports');
      }

      const data: ReportsApiResponse = await response.json();
      const filesWithIds = (data.files || []).map((file, idx) => ({
        ...file,
        id: `report-${idx}-${file.filename}`
      }));

      setReports(filesWithIds);

      // Fetch additional document from Supabase
      try {
        console.log('Fetching additional document from Supabase for case:', caseData.id);
        const additionalDoc = await fetchAdditionalDocument(caseData.id);
        if (additionalDoc) {
          console.log('✓ Additional document loaded:', JSON.stringify(additionalDoc, null, 2));
          setAdditionalDocument(additionalDoc);
        } else {
          console.log('No additional document found in Supabase');
        }
      } catch (docErr) {
        console.error('Error fetching additional document:', docErr);
        // Don't fail the entire component if additional doc fails
      }
    } catch (err) {
      console.error('Error fetching reports:', err);
      setError('Unable to load reports right now. Please try again later.');
    } finally {
      setLoading(false);
    }
  }, [caseData.id, caseData.reportStatus, caseData.requestId]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleVerifyReports = async () => {
    setIsVerifying(true);
    try {
      await verifyReport(caseData.id);
      showToast.success('Reports verified successfully');
    } catch (error) {
      console.error('Failed to verify reports:', error);
      showToast.error('Failed to verify reports. Please try again.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleEnterEditMode = () => {
    if (!isOwner) return;
    setIsEditMode(true);
    setFilesToDelete([]);
    setFilesToUpload([]);
  };

  const handleCancelEdit = () => {
    setIsEditMode(false);
    setFilesToDelete([]);
    setFilesToUpload([]);
    setAdditionalDataDraft(null);
    showToast.info('Edit mode cancelled');
  };

  const handleMarkForDeletion = (reportId: string) => {
    if (isSaving) return;
    const report = reports.find(r => r.id === reportId);
    if (report?.filename) {
      setFilesToDelete(prev => [...prev, report.filename]);
      showToast.success('Report marked for deletion');
    }
  };

  // Allowed file extensions for upload
  const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'doc', 'docx', 'ppt', 'pptx', 'pdf', 'txt'];

  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isSaving) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const validFiles: File[] = [];
    const rejectedFiles: string[] = [];
    const blockedPdfs: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const extension = getFileExtension(file.name);

      // File extension validation
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        rejectedFiles.push(file.name);
        continue;
      }

      // PDF page limit validation - strictly block PDFs with more than 50 pages
      if (file.type === 'application/pdf' || extension === 'pdf') {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdfjsLib = await import('pdfjs-dist');
          pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          const pageCount = pdf.numPages;
          
          if (pageCount > 50) {
            blockedPdfs.push(`"${file.name}" (${pageCount} pages)`);
            continue; // Skip this file
          }
        } catch (err) {
          console.warn('Could not validate PDF page count for:', file.name, err);
          // If validation fails, still allow upload
        }
      }

      validFiles.push(file);
    }

    // Show error messages for rejected files
    if (blockedPdfs.length > 0) {
      setError(`This PDF contains more than 50 pages. Uploading PDFs with more than 50 pages is not allowed: ${blockedPdfs.join(', ')}`);
      showToast.error('This PDF contains more than 50 pages. Uploading PDFs with more than 50 pages is not allowed.');
    }
    
    if (rejectedFiles.length > 0) {
      const msg = `File type not allowed. Only png, jpg, jpeg, doc, docx, ppt, pptx, pdf, txt files are accepted: ${rejectedFiles.join(', ')}`;
      setError(prev => prev ? `${prev} | ${msg}` : msg);
      showToast.error('File type not allowed. Only png, jpg, jpeg, doc, docx, ppt, pptx, pdf, txt files are accepted.');
    }

    if (validFiles.length > 0) {
      setUploadingFiles(validFiles);
      setShowUploadModal(true);
    }
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleConfirmUpload = () => {
    setFilesToUpload(prev => [...prev, ...uploadingFiles]);
    setUploadingFiles([]);
    setShowUploadModal(false);
  };

  const handleOpenAdditionalDataModal = () => {
    if (isSaving) return;
    console.log('=== OPENING MODAL ===');
    console.log('Current additionalDocument state:', JSON.stringify(additionalDocument, null, 2));
    console.log('Current additionalDataDraft state:', JSON.stringify(additionalDataDraft, null, 2));
    console.log('Current showAdditionalDataModal:', showAdditionalDataModal);
    
    const source = additionalDataDraft || additionalDocument;

    if (source) {
      console.log('Loading existing document into modal fields');
      setAdditionalDataTitle(source.title);
      setAdditionalDataContent(source.content);
    } else {
      console.log('No existing document, initializing empty');
      setAdditionalDataTitle('Additional Data');
      setAdditionalDataContent('');
    }
    setShowAdditionalDataModal(true);
    console.log('Modal should now be visible');
  };

  const handleSaveAdditionalData = async () => {
    console.log('=== SAVING ADDITIONAL DATA ===');
    console.log('Title:', additionalDataTitle);
    console.log('Content length:', additionalDataContent.length);
    
    const docToSave = {
      title: additionalDataTitle || 'Additional Data',
      content: additionalDataContent
    };
    
    console.log('Document to save:', JSON.stringify(docToSave, null, 2));
    
    // Update local draft/state only; persistence happens on Save All
    setAdditionalDataDraft(docToSave);
    setAdditionalDocument(docToSave);
    console.log('Local draft updated');

    setShowAdditionalDataModal(false);
    console.log('=== SAVE COMPLETE (draft only) ===');
  };

  const handleViewAdditionalData = () => {
    if (additionalDocument) {
      openViewer({ 
        filename: additionalDocument.title, 
        url: '', 
        id: 'additional-data' 
      });
    }
  };

  const handleSaveAll = async () => {
    if (!caseData.requestId) {
      showToast.error('Request ID missing. Cannot update reports.');
      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      // STEP 1: Delete reports (if any)
      if (filesToDelete.length > 0) {
        console.log('🗑️ Deleting reports:', filesToDelete);
        await deleteReportsForRequest(caseData.requestId, filesToDelete);
        console.log('✓ Delete complete');
      }

      // STEP 2: Upload new reports (if any)
      if (filesToUpload.length > 0) {
        console.log('📡 Getting upload config for existing request');
        const { uploadUrl, uploadPrefix, uploadFields } = await getUploadConfigForExistingRequest(caseData.requestId);
        console.log('📤 Uploading new reports:', filesToUpload.map(f => f.name));
        await uploadFilesToS3(filesToUpload, uploadUrl, uploadPrefix, uploadFields);
        console.log('✓ Uploads complete');
      }

      // STEP 3: Save / update additional data
      const latestAdditional = additionalDataDraft || additionalDocument;
      const additionalPayload: AdditionalDocument = {
        title: latestAdditional?.title || 'Additional Data',
        content: latestAdditional?.content || '',
      };
      console.log('💾 Saving additional data to Supabase...');
      await updateAdditionalDocument(additionalPayload, caseData.id);
      console.log('✓ Additional data saved');
      setAdditionalDocument(additionalPayload);

      // STEP 4: Update case status to processing before triggering summary regeneration
      console.log('📈 Marking case as processing...');
      await markCaseProcessing(caseData.id);
      console.log('✓ Case status updated');

      // STEP 5: Trigger reprocessing (summary regeneration)
      console.log('⚙️ Triggering converter...');
      await triggerReprocessing(caseData.requestId, caseData.id, additionalPayload.content);
      console.log('✓ Converter triggered');

      // STEP 6: Refetch the latest report_status from database
      console.log('🔄 Refetching case data to get latest report_status...');
      const { supabase } = await import('../Supabase/client');
      const { data: updatedCase, error: fetchError } = await supabase
        .from('cases')
        .select('report_status')
        .eq('id', caseData.id)
        .single();
      
      if (fetchError) {
        console.error('Failed to refetch case data:', fetchError);
      } else if (updatedCase) {
        console.log('✓ Latest report_status:', updatedCase.report_status);
        // Update the parent component's case data
        caseData.reportStatus = updatedCase.report_status;
      }

      // Exit edit mode, reset local queues, and reload reports in view mode
      setIsEditMode(false);
      setFilesToDelete([]);
      setFilesToUpload([]);
      setAdditionalDataDraft(null);
      await loadReports();
      
      showToast.success('Changes saved successfully. Reports are being reprocessed.');
    } catch (err) {
      console.error('Save failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to save changes.';
      setError(message);
      showToast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const isProcessing = caseData.reportStatus === 'not_ready';

  // Open full-screen viewer
  const openViewer = (report: ReportFile) => {
    setViewerReport(report);
    setZoomLevel(100);
  };

  // Close full-screen viewer
  const closeViewer = () => {
    setViewerReport(null);
    setZoomLevel(100);
  };

  // Pending uploads as pseudo-reports for UI
  const pendingReports: ReportFile[] = filesToUpload.map((file, idx) => ({
    id: `pending-${idx}-${file.name}`,
    filename: file.name,
    url: getObjectUrl(file),
    pending: true,
    file,
  }));

  // Filter out deleted reports and combine with pending uploads
  const displayedReports = [
    ...reports.filter(r => !filesToDelete.includes(r.filename)),
    ...pendingReports,
  ];

  // Generate PDF thumbnails
  useEffect(() => {
    const pdfReports = reports.filter(r =>
      r.filename.toLowerCase().endsWith('.pdf') &&
      !filesToDelete.includes(r.filename) &&
      !thumbnailsRequested.current.has(r.id || r.filename)
    );
    if (pdfReports.length === 0) return;

    let cancelled = false;

    (async () => {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

      for (const report of pdfReports) {
        if (cancelled) break;
        const key = report.id || report.filename;
        thumbnailsRequested.current.add(key);
        try {
          // Try fetch-as-ArrayBuffer first; fall back to loading by URL
          let pdf;
          try {
            const resp = await fetch(report.url);
            const arrayBuf = await resp.arrayBuffer();
            pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
          } catch {
            // If fetch fails (e.g. CORS), let pdfjs load from URL directly
            pdf = await pdfjsLib.getDocument({
              url: report.url,
              disableAutoFetch: true,
              disableStream: true,
            }).promise;
          }
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 0.8 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) { pdf.destroy(); continue; }
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (!cancelled) {
            setThumbnails(prev => ({ ...prev, [key]: canvas.toDataURL('image/jpeg', 0.8) }));
          }
          pdf.destroy();
        } catch {
          // Silently fail - will show generic icon fallback
        }
      }
    })();

    return () => { cancelled = true; };
  }, [reports, filesToDelete]);

  return (
    <div className="w-full flex flex-col gap-4">
      {isSaving && (
        <div className="fixed inset-0 z-[120000] bg-white/70 backdrop-blur-sm flex items-center justify-center">
          <div className="flex items-center gap-3 text-gray-800 bg-white/90 px-4 py-3 rounded-lg shadow">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="font-medium">Saving changes...</span>
          </div>
        </div>
      )}

      {/* Processing Message */}
      {isProcessing && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <Loader2 className="w-8 h-8 text-blue-600 mx-auto mb-3 animate-spin" />
          <p className="text-sm text-blue-800 font-medium">
            Reports are still anonymizing. Please wait. They will be available shortly.
          </p>
        </div>
      )}

      {/* Error Message */}
      {error && !isProcessing && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
          <AlertTriangle className="w-6 h-6 text-red-600 mx-auto mb-2" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && !isProcessing && (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <Loader2 className="w-8 h-8 text-blue-600 mx-auto mb-3 animate-spin" />
          <p className="text-sm text-gray-600">Loading reports...</p>
        </div>
      )}

      {/* Main Content - Grid Layout */}
      {!isProcessing && !loading && !error && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className={`font-bold ${isMobile ? 'text-lg' : 'text-xl'}`} style={{ color: '#1a1a1a' }}>All Reports</h2>
            <div className="flex items-center gap-3">
              {isOwner && (
                !isEditMode ? (
                  <button
                    onClick={handleEnterEditMode}
                    disabled={isSaving}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-gray-600 bg-gray-50 border border-gray-200 hover:bg-gray-100 transition-colors"
                  >
                    <Edit className="w-4 h-4" />
                    <span>Edit</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleCancelEdit}
                      disabled={isSaving}
                      className="px-4 py-2 text-sm font-medium rounded-lg text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveAll}
                      disabled={isSaving}
                      className="px-4 py-2 text-sm font-medium rounded-lg text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                      style={{ backgroundColor: '#4A90E2' }}
                    >
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                )
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              accept=".png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.pdf,.txt"
            />
          </div>

          {/* Report Grid */}
          {displayedReports.length > 0 || additionalDocument ? (
            <div className={`grid gap-3 ${isMobile ? 'grid-cols-2' : 'grid-cols-4 max-w-5xl'}`}>
              {/* Additional Document Card */}
              {additionalDocument && (
                <div
                  className="group relative rounded-xl border-2 border-gray-200 hover:border-blue-300 hover:shadow-lg transition-all cursor-pointer bg-white overflow-hidden"
                  onClick={() => openViewer({ id: 'additional-data', filename: additionalDocument.title, url: '' })}
                >
                  <div className="aspect-[4/3] bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center">
                    <FileText className={`${isMobile ? 'w-7 h-7' : 'w-10 h-10'} text-green-400`} />
                  </div>
                  <div className="px-3 py-2 border-t border-gray-100">
                    <p className={`font-medium text-gray-900 truncate ${isMobile ? 'text-xs' : 'text-sm leading-tight'}`}>{additionalDocument.title}</p>
                    <p className={`text-gray-400 mt-0.5 ${isMobile ? 'text-[10px]' : 'text-xs'}`}>Your data</p>
                  </div>
                </div>
              )}

              {/* Report Cards */}
              {displayedReports.map((report) => {
                const reportKey = report.id || report.filename;
                const isImage = isImageFile(report.filename);
                const isPdf = report.filename.toLowerCase().endsWith('.pdf');
                const thumbnailUrl = thumbnails[reportKey];
                const previewUrl = report.pending && report.file ? getObjectUrl(report.file) : report.url;

                return (
                  <div
                    key={reportKey}
                    className="group relative rounded-xl border-2 border-gray-200 hover:border-blue-300 hover:shadow-lg transition-all cursor-pointer bg-white overflow-hidden"
                    onClick={() => !isEditMode && openViewer(report)}
                  >
                    {/* Preview Area */}
                    <div className="aspect-[4/3] bg-gray-100 flex items-center justify-center overflow-hidden relative">
                      {isImage ? (
                        <img
                          src={previewUrl}
                          alt={stripReportPrefix(report.filename)}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : isPdf && thumbnailUrl ? (
                        <img
                          src={thumbnailUrl}
                          alt={stripReportPrefix(report.filename)}
                          className="w-full h-full object-contain bg-white p-1"
                        />
                      ) : isPdf ? (
                        <div className="flex flex-col items-center justify-center gap-1">
                          <FileText className={`${isMobile ? 'w-7 h-7' : 'w-10 h-10'} text-red-300`} />
                          <span className="text-[10px] text-gray-400">PDF</span>
                        </div>
                      ) : (
                        <FileText className={`${isMobile ? 'w-7 h-7' : 'w-10 h-10'} text-gray-300`} />
                      )}
                      {report.pending && (
                        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-amber-500 text-white text-[9px] font-medium rounded-full">
                          Pending
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className={`px-3 py-2 border-t border-gray-100 ${isEditMode ? 'pr-10' : ''}`}>
                      <p className={`font-medium text-gray-900 truncate ${isMobile ? 'text-xs' : 'text-sm leading-tight'}`}>
                        {stripReportPrefix(report.filename)}
                      </p>
                      <p className={`text-gray-400 mt-0.5 ${isMobile ? 'text-[10px]' : 'text-xs'}`}>
                        {report.pending
                          ? 'Pending upload'
                          : caseData.createdDate
                          ? new Date(caseData.createdDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                          : 'Report'}
                      </p>
                    </div>

                    {/* Delete button - Edit mode only */}
                    {isEditMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleMarkForDeletion(report.id!); }}
                        disabled={isSaving}
                        className="absolute bottom-3 right-3 p-1.5 bg-white rounded-full shadow-md border border-gray-200 hover:bg-red-50 hover:border-red-300 transition-colors"
                        title="Delete report"
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
              <FileText className={`text-gray-200 mx-auto mb-4 ${isMobile ? 'w-12 h-12' : 'w-16 h-16'}`} />
              <p className="text-gray-500 font-medium">No reports available for this case.</p>
            </div>
          )}

          {/* Edit Mode Bottom Buttons */}
          {isEditMode && (
            <div className={`flex ${isMobile ? 'flex-col gap-3' : 'justify-between'} mt-2`}>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isSaving}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg border-2 border-dashed border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                <span>Upload More Documents</span>
              </button>
              <button
                onClick={handleOpenAdditionalDataModal}
                disabled={isSaving}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg border-2 border-dashed border-gray-300 text-gray-600 hover:border-green-400 hover:text-green-600 hover:bg-green-50 transition-colors disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                <span>{additionalDocument ? 'Edit Your Data' : 'Create Your Own Data'}</span>
              </button>
            </div>
          )}
        </>
      )}

      {/* Full-Screen Report Viewer */}
      {viewerReport && (
        <div className="fixed inset-0 z-[100000] bg-black/80" onClick={closeViewer}>
          {/* Top bar */}
          <div className="absolute top-0 left-0 right-0 h-14 flex items-center justify-between px-6 z-10" onClick={(e) => e.stopPropagation()}>
            <span className="text-white text-sm font-medium truncate max-w-md">
              {viewerReport.id === 'additional-data'
                ? additionalDocument?.title || 'Additional Data'
                : stripReportPrefix(viewerReport.filename)}
            </span>
            <div className="flex items-center gap-4">
              {/* Zoom controls for images */}
              {isImageFile(viewerReport.filename) && viewerReport.id !== 'additional-data' && (
                <div className="flex items-center gap-2 bg-white/10 rounded-lg px-3 py-1.5">
                  <button
                    onClick={() => setZoomLevel(z => Math.max(25, z - 25))}
                    className="text-white hover:text-blue-300 transition-colors"
                    title="Zoom out"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-white text-xs min-w-[3rem] text-center">{zoomLevel}%</span>
                  <button
                    onClick={() => setZoomLevel(z => Math.min(400, z + 25))}
                    className="text-white hover:text-blue-300 transition-colors"
                    title="Zoom in"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                </div>
              )}
              <button
                onClick={closeViewer}
                className="p-2 rounded-full hover:bg-white/10 transition-colors"
                title="Close"
              >
                <X className="w-6 h-6 text-white" />
              </button>
            </div>
          </div>

          {/* Viewer Content */}
          <div
            className="absolute inset-0 top-14 overflow-auto flex items-center justify-center p-4"
            onClick={closeViewer}
          >
            {viewerReport.id === 'additional-data' && additionalDocument ? (
              <div className="bg-white rounded-xl p-8 max-w-4xl w-full max-h-[85vh] overflow-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-xl font-bold text-gray-900 mb-4">{additionalDocument.title}</h2>
                <pre className="whitespace-pre-wrap text-gray-700 text-sm leading-relaxed">{additionalDocument.content}</pre>
              </div>
            ) : viewerReport.pending && viewerReport.file ? (
              (() => {
                const vIsImage = isImageFile(viewerReport.filename) || viewerReport.file!.type.startsWith('image/');
                const vIsPdf = viewerReport.filename.toLowerCase().endsWith('.pdf') || viewerReport.file!.type === 'application/pdf';
                const objectUrl = getObjectUrl(viewerReport.file!);

                if (vIsImage) {
                  return (
                    <img
                      src={objectUrl}
                      alt={stripReportPrefix(viewerReport.filename)}
                      style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'center center' }}
                      className="max-w-none transition-transform duration-200"
                      draggable={false}
                      onClick={(e) => e.stopPropagation()}
                    />
                  );
                }

                if (vIsPdf) {
                  return (
                    <iframe
                      src={objectUrl}
                      className="w-[90vw] h-[85vh] rounded-lg bg-white"
                      title={stripReportPrefix(viewerReport.filename)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  );
                }

                return (
                  <div className="bg-white rounded-xl p-8 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <FileText className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <p className="font-medium text-gray-900">{stripReportPrefix(viewerReport.filename)}</p>
                    <p className="text-gray-500 mt-1 text-sm">Preview will be available after save.</p>
                  </div>
                );
              })()
            ) : isImageFile(viewerReport.filename) ? (
              <img
                src={viewerReport.url}
                alt={stripReportPrefix(viewerReport.filename)}
                style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'center center' }}
                className="max-w-none transition-transform duration-200"
                draggable={false}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <iframe
                src={viewerReport.url}
                className="w-[90vw] h-[85vh] rounded-lg bg-white"
                title={stripReportPrefix(viewerReport.filename)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
      )}

      {/* Upload Confirmation Modal */}
      {showUploadModal && (
        <Modal
          isOpen={showUploadModal}
          onClose={() => setShowUploadModal(false)}
          title="Add Documents to Queue"
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-gray-900">Selected Files ({uploadingFiles.length})</h4>
              <ul className="text-sm text-gray-700 space-y-1 max-h-60 overflow-y-auto">
                {uploadingFiles.map((file, idx) => (
                  <li key={idx} className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-gray-400" />
                    <span className="flex-1 truncate">{file.name}</span>
                    <span className="text-gray-500 text-xs">({(file.size / (1024 * 1024)).toFixed(2)} MB)</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-sm text-gray-600 bg-blue-50 border border-blue-200 rounded-md p-3">
              These files will be added to your upload queue. Click &quot;Save&quot; to upload them.
            </p>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setUploadingFiles([]);
                }}
                disabled={isSaving}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmUpload}
                disabled={isSaving}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2"
                style={{ backgroundColor: '#4A90E2' }}
              >
                <Plus className="w-4 h-4" />
                <span>Add to Queue</span>
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Additional Data Modal */}
      {showAdditionalDataModal && (
        <Modal
          isOpen={showAdditionalDataModal}
          onClose={() => setShowAdditionalDataModal(false)}
          title={additionalDocument ? 'Edit Your Data' : 'Create Your Own Data'}
          size="large"
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="additional-title" className="block text-sm font-medium text-gray-700 mb-1">
                Title
              </label>
              <input
                id="additional-title"
                type="text"
                value={additionalDataTitle}
                onChange={(e) => setAdditionalDataTitle(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter a title for your data..."
              />
            </div>

            <div>
              <label htmlFor="additional-content" className="block text-sm font-medium text-gray-700 mb-1">
                Content
              </label>
              <textarea
                id="additional-content"
                value={additionalDataContent}
                onChange={(e) => setAdditionalDataContent(e.target.value)}
                rows={20}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                placeholder="Enter your additional data here..."
              />
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowAdditionalDataModal(false)}
                disabled={isSaving}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveAdditionalData}
                disabled={isSaving}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2"
                style={{ backgroundColor: '#4A90E2' }}
              >
                <Save className="w-4 h-4" />
                <span>Save</span>
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
