import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useCaseCreation, PendingFile } from '../context/CaseCreationContext';
import { supabase } from '../Supabase/client';
import { useIsMobile } from '../hooks/useMobile';
import { FileText, X, Upload, AlertCircle } from 'lucide-react';
// @ts-ignore - pdfjs types may not be available
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker - must use .mjs for pdfjs-dist v5+
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'doc', 'docx', 'ppt', 'pptx', 'pdf', 'txt'];

export default function NewCaseStep1() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { step1Data, setStep1Data, pendingFiles, addFiles, removeFile, clearAll } = useCaseCreation();
  
  const [formData, setFormData] = useState({
    caseName: step1Data?.caseName || '',
    patientName: step1Data?.patientName || '',
    age: step1Data?.age || '',
    sex: step1Data?.sex || '',
    cancerType: step1Data?.cancerType || '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const cancerTypes = [
    "Acute Lymphoblastic Leukemia",
    "Acute Myeloid Leukemia",
    "Adrenocortical Carcinoma",
    "AIDS-Related Lymphoma",
    "AIDS-Related Malignancies",
    "Anal Cancer",
    "Appendix Cancer",
    "Astrocytoma",
    "Atypical Teratoid/Rhabdoid Tumor",
    "Bile Duct Cancer",
    "Bladder Cancer",
    "Bone Cancer",
    "Brain Tumor",
    "Breast Cancer",
    "Bronchial Tumors",
    "Burkitt Lymphoma",
    "Carcinoid Tumor",
    "Cardiac Tumors",
    "Cervical Cancer",
    "Childhood Cancers",
    "Cholangiocarcinoma",
    "Chordoma",
    "Chronic Lymphocytic Leukemia",
    "Chronic Myelogenous Leukemia",
    "Chronic Myeloproliferative Neoplasms",
    "Colon Cancer",
    "Colorectal Cancer",
    "Craniopharyngioma",
    "Cutaneous T-Cell Lymphoma",
    "Ductal Carcinoma In Situ",
    "Embryonal Tumors",
    "Endometrial Cancer",
    "Ependymoma",
    "Esophageal Cancer",
    "Esthesioneuroblastoma",
    "Ewing Sarcoma",
    "Eye Cancer",
    "Fallopian Tube Cancer",
    "Gallbladder Cancer",
    "Gastric Cancer",
    "Gastrointestinal Carcinoid Tumor",
    "Gastrointestinal Stromal Tumor",
    "Germ Cell Tumors",
    "Gestational Trophoblastic Disease",
    "Glioblastoma",
    "Glioma",
    "Hairy Cell Leukemia",
    "Head and Neck Cancer",
    "Heart Tumors",
    "Hepatocellular Cancer",
    "Histiocytosis",
    "Hodgkin Lymphoma",
    "Hypopharyngeal Cancer",
    "Intraocular Melanoma",
    "Islet Cell Tumors",
    "Kaposi Sarcoma",
    "Kidney Cancer",
    "Langerhans Cell Histiocytosis",
    "Laryngeal Cancer",
    "Leukemia",
    "Lip and Oral Cavity Cancer",
    "Liver Cancer",
    "Lung Cancer",
    "Lymphoma",
    "Malignant Mesothelioma",
    "Medulloblastoma",
    "Melanoma",
    "Merkel Cell Carcinoma",
    "Mesothelioma",
    "Metastatic Cancer",
    "Metastatic Squamous Neck Cancer",
    "Midline Tract Carcinoma",
    "Mouth Cancer",
    "Multiple Endocrine Neoplasia Syndromes",
    "Multiple Myeloma",
    "Mycosis Fungoides",
    "Myelodysplastic Syndromes",
    "Myeloproliferative Neoplasms",
    "Nasal Cavity and Paranasal Sinus Cancer",
    "Nasopharyngeal Cancer",
    "Neuroblastoma",
    "Non-Hodgkin Lymphoma",
    "Non-Small Cell Lung Cancer",
    "Oral Cancer",
    "Oropharyngeal Cancer",
    "Osteosarcoma",
    "Ovarian Cancer",
    "Pancreatic Cancer",
    "Papillomatosis",
    "Paraganglioma",
    "Paranasal Sinus Cancer",
    "Parathyroid Cancer",
    "Penile Cancer",
    "Pharyngeal Cancer",
    "Pheochromocytoma",
    "Pituitary Tumors",
    "Plasma Cell Neoplasm",
    "Pleuropulmonary Blastoma",
    "Primary Central Nervous System Lymphoma",
    "Primary Peritoneal Cancer",
    "Prostate Cancer",
    "Rectal Cancer",
    "Renal Cell Cancer",
    "Retinoblastoma",
    "Rhabdomyosarcoma",
    "Salivary Gland Cancer",
    "Sarcoma",
    "Sézary Syndrome",
    "Skin Cancer",
    "Small Cell Lung Cancer",
    "Small Intestine Cancer",
    "Soft Tissue Sarcoma",
    "Squamous Cell Carcinoma",
    "Squamous Neck Cancer",
    "Stomach Cancer",
    "T-Cell Lymphoma",
    "Testicular Cancer",
    "Throat Cancer",
    "Thymoma",
    "Thymic Carcinoma",
    "Thyroid Cancer",
    "Transitional Cell Cancer",
    "Urethral Cancer",
    "Uterine Cancer",
    "Uterine Sarcoma",
    "Vaginal Cancer",
    "Vascular Tumors",
    "Vulvar Cancer",
    "Waldenstrom Macroglobulinemia",
    "Wilms Tumor"
  ];

  // Generate case name when cancer type changes
  useEffect(() => {
    if (formData.cancerType) {
      generateCaseName(formData.cancerType);
    }
  }, [formData.cancerType]);

  const generateCaseName = async (cancerType: string) => {
    if (!cancerType) return;
    
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = today.getFullYear();
    const dateStr = `${day}${month}${year}`;
    
    const baseName = `${cancerType.replace(/\s+/g, '')}-${dateStr}`;
    
    const { data } = await supabase
      .from('cases')
      .select('case_name')
      .ilike('case_name', `${baseName}%`);
    
    let suffix = 1;
    if (data && data.length > 0) {
      const existingNumbers = data
        .map(c => {
          const match = c.case_name.match(new RegExp(`${baseName}-(\\d+)`));
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter(n => n > 0);
      
      if (existingNumbers.length > 0) {
        suffix = Math.max(...existingNumbers) + 1;
      }
    }
    
    const generatedName = `${baseName}-${suffix}`;
    setFormData(prev => ({ ...prev, caseName: generatedName }));
  };

  const isCaseNameUnique = async (caseName: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('cases')
      .select('id')
      .eq('case_name', caseName)
      .maybeSingle();
    
    if (error) {
      console.error('Error checking case name:', error);
      throw error;
    }
    
    return !data;
  };

  // File upload handlers
  const getPdfPageCount = async (file: File): Promise<number> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    return pdf.numPages;
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setError(null);
    const newPendingFiles: PendingFile[] = [];
    const rejectedFiles: string[] = [];
    const blockedPdfs: string[] = [];
    const unvalidatedPdfs: string[] = [];

    for (const file of files) {
      const extension = file.name.split('.').pop()?.toLowerCase()?.trim() || '';
      
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        rejectedFiles.push(file.name);
        continue;
      }

      // CRITICAL: Block PDFs over 50 pages (if we can validate)
      if (extension === 'pdf') {
        try {
          const pageCount = await getPdfPageCount(file);
          if (pageCount > 50) {
            blockedPdfs.push(file.name);
            continue;
          }
        } catch (err) {
          console.error('PDF validation error:', err);
          // Allow upload but track that it couldn't be validated
          unvalidatedPdfs.push(file.name);
        }
      }

      let rawText: string | undefined = undefined;
      if (extension === 'txt') {
        rawText = await file.text();
      }

      const pendingFile: PendingFile = {
        id: Date.now().toString() + Math.random(),
        file,
        type: 'Clinical',
        name: file.name,
        size: `${(file.size / 1024).toFixed(2)} KB`,
        mimeType: file.type,
        rawText,
      };

      newPendingFiles.push(pendingFile);
    }

    // Show error messages for rejected files
    const errorMessages: string[] = [];
    const warningMessages: string[] = [];
    
    if (blockedPdfs.length > 0) {
      errorMessages.push(`This PDF contains more than 50 pages. Uploading PDFs with more than 50 pages is not allowed: ${blockedPdfs.join(', ')}`);
    }
    
    if (unvalidatedPdfs.length > 0) {
      warningMessages.push(`Warning: Could not validate page count for PDF(s). Please ensure they don't exceed 50 pages: ${unvalidatedPdfs.join(', ')}`);
    }
    
    if (rejectedFiles.length > 0) {
      errorMessages.push(`File type not allowed. Only png, jpg, jpeg, doc, docx, ppt, pptx, pdf, txt files are accepted: ${rejectedFiles.join(', ')}`);
    }

    // Add files with duplicate check
    const result = addFiles(newPendingFiles);
    if (!result.success) {
      errorMessages.push(`File(s) with the same name already uploaded: ${result.duplicates.join(', ')}`);
    }
    // Combine errors and warnings
    const allMessages = [...errorMessages, ...warningMessages];
    if (allMessages.length > 0) {
      setError(allMessages.join(' | '));
    }
    
    event.target.value = ''; // Reset input to allow same file again
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const isUnique = await isCaseNameUnique(formData.caseName);
      if (!isUnique) {
        setError('This case name already exists. Please choose a different name.');
        return;
      }
      
      // Save to context
      setStep1Data(formData);
      navigate('/cases/new/step-2');
    } catch (err: any) {
      setError(err?.message || 'Failed to validate case name');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-7xl mx-auto">
        <div className={isMobile ? 'mb-4' : 'mb-6'}>
          <h1 className={`font-bold ${isMobile ? 'text-xl' : 'text-2xl'}`} style={{ color: '#4A5565' }}>Create New Case</h1>
          <p className={`text-gray-600 mt-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>Step 1 of 3: Basic Details & Upload Documents</p>
        </div>

        {error && (
          <div className={`mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3 ${isMobile ? 'text-xs p-3' : 'text-sm'}`}>
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-red-700 flex-1">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className={`grid gap-6 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {/* LEFT SIDE: Patient Information */}
            <div className="bg-white rounded-2xl shadow-sm p-6 space-y-5">
              <div>
                <h3 className="text-lg font-semibold mb-4" style={{ color: '#4A5565' }}>Patient Information</h3>
              </div>

              <div>
                <label htmlFor="patientName" className="block text-sm font-medium mb-2" style={{ color: '#4A5565' }}>
                  Patient Name (Optional)
                </label>
                <input
                  id="patientName"
                  type="text"
                  value={formData.patientName}
                  onChange={(e) => setFormData({ ...formData, patientName: e.target.value })}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2"
                  style={{ 
                    fontSize: '16px',
                    '--tw-ring-color': '#4A90E2'
                  } as React.CSSProperties}
                  placeholder="Leave empty for anonymous"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="age" className="block text-sm font-medium mb-2" style={{ color: '#4A5565' }}>
                    Age <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="age"
                    type="number"
                    value={formData.age}
                    onChange={(e) => setFormData({ ...formData, age: e.target.value })}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2"
                    style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="sex" className="block text-sm font-medium mb-2" style={{ color: '#4A5565' }}>
                    Sex <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="sex"
                    value={formData.sex}
                    onChange={(e) => setFormData({ ...formData, sex: e.target.value })}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2"
                    style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                    required
                  >
                    <option value="">Select</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="cancerType" className="block text-sm font-medium mb-2" style={{ color: '#4A5565' }}>
                  Cancer Type <span className="text-red-500">*</span>
                </label>
                <input
                  id="cancerType"
                  type="text"
                  list="cancerTypesList"
                  value={formData.cancerType}
                  onChange={(e) => setFormData({ ...formData, cancerType: e.target.value })}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                  placeholder="Type or select cancer type"
                  required
                />
                <datalist id="cancerTypesList">
                  {cancerTypes.map((type) => (
                    <option key={type} value={type} />
                  ))}
                </datalist>
                <p className="text-xs text-gray-500 mt-1.5">Start typing to see suggestions or enter your own</p>
              </div>

              <div>
                <label htmlFor="caseName" className="block text-sm font-medium mb-2" style={{ color: '#4A5565' }}>
                  Case Name <span className="text-red-500">*</span>
                </label>
                <input
                  id="caseName"
                  type="text"
                  value={formData.caseName}
                  onChange={(e) => setFormData({ ...formData, caseName: e.target.value })}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg bg-gray-50 focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
                  placeholder="Auto-generated based on cancer type"
                  required
                />
                <p className="text-xs text-gray-500 mt-1.5">Auto-generated from cancer type and date. You can modify if needed.</p>
              </div>
            </div>

            {/* RIGHT SIDE: Upload Documents */}
            <div className="bg-white rounded-2xl shadow-sm p-6">
              <div className="mb-5">
                <h3 className="text-lg font-semibold mb-2" style={{ color: '#4A5565' }}>Upload Documents</h3>
                <p className="text-xs text-gray-500">Add clinical documents (optional)</p>
              </div>

              {/* Upload Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-gray-300 rounded-lg p-8 hover:border-blue-400 hover:bg-blue-50 transition-all group mb-5"
              >
                <Upload className="w-10 h-10 mx-auto mb-3 text-gray-400 group-hover:text-blue-600" />
                <p className="text-sm font-medium text-gray-700 group-hover:text-blue-700">Click to Upload Files</p>
                <p className="text-xs text-gray-500 mt-1">PNG, JPG, DOC, DOCX, PPT, PPTX, PDF, TXT</p>
                <p className="text-xs text-gray-400 mt-1">Max 50 pages for PDF files</p>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileUpload}
                accept=".png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.pdf,.txt,image/png,image/jpeg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain"
              />

              {/* Uploaded Files List */}
              {pendingFiles.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-3" style={{ color: '#4A5565' }}>
                    Uploaded Files ({pendingFiles.length})
                  </p>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {pendingFiles.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center justify-between bg-gray-50 rounded-lg p-3 border border-gray-100"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <FileText className="w-5 h-5 text-gray-400 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 truncate">{doc.name}</p>
                            <p className="text-xs text-gray-500">{doc.size}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeFile(doc.id)}
                          className="text-red-500 hover:text-red-700 ml-2 flex-shrink-0"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pendingFiles.length === 0 && (
                <p className="text-sm text-gray-400 text-center">No files uploaded yet</p>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className={`flex justify-end gap-3 mt-6 ${isMobile ? 'flex-col' : ''}`}>
            <button
              type="button"
              onClick={() => {
                clearAll();
                navigate('/my-cases');
              }}
              className={`px-6 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors ${isMobile ? 'w-full' : ''}`}
              style={{ color: '#4A5565' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className={`px-8 py-2.5 text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ${isMobile ? 'w-full' : ''}`}
              style={{ backgroundColor: '#4A90E2' }}
            >
              {loading ? 'Validating...' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
