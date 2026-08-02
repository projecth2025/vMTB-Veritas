import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { supabase } from '../Supabase/client';
import { useCaseCreation } from '../context/CaseCreationContext';
import { useIsMobile } from '../hooks/useMobile';

const cancerTypes = [
  'Acute Lymphoblastic Leukemia',
  'Acute Myeloid Leukemia',
  'Ampullary Adenocarcinoma',
  'Anal Carcinoma',
  'Appendiceal Neoplasms and Cancers',
  'Basal Cell Skin Cancer',
  'B-Cell Lymphomas',
  'Biliary Tract Cancers',
  'Bladder Cancer',
  'Bone Cancer',
  'Breast Cancer',
  'Castleman Disease',
  'Central Nervous System Cancers',
  'Cervical Cancer',
  'Chronic Lymphocytic Leukemia/Small Lymphocytic Lymphoma',
  'Chronic Myeloid Leukemia',
  'Colon Cancer',
  'Cutaneous Lymphomas',
  'Dermatofibrosarcoma Protuberans',
  'Esophageal and Esophagogastric Junction Cancers',
  'Gastric Cancer',
  'Gastrointestinal Stromal Tumors',
  'Gestational Trophoblastic Neoplasia',
  'Hairy Cell Leukemia',
  'Head and Neck Cancers',
  'Hepatobiliary Cancers',
  'Hepatocellular Carcinoma',
  'Histiocytic Neoplasms',
  'Hodgkin Lymphoma',
  'Kaposi Sarcoma',
  'Kidney Cancer',
  'Melanoma: Cutaneous',
  'Melanoma: Uveal',
  'Merkel Cell Carcinoma',
  'Mesothelioma: Peritoneal',
  'Mesothelioma: Pleural',
  'Multiple Myeloma',
  'Myelodysplastic Syndromes',
  'Myeloid/Lymphoid Neoplasms with Eosinophilia and Tyrosine Kinase Gene Fusions',
  'Myeloproliferative Neoplasms',
  'Neuroblastoma',
  'Neuroendocrine and Adrenal Tumors',
  'Non-Small Cell Lung Cancer',
  'Occult Primary',
  'Ovarian Cancer/Fallopian Tube Cancer/Primary Peritoneal Cancer',
  'Pancreatic Adenocarcinoma',
  'Pediatric Acute Lymphoblastic Leukemia',
  'Pediatric Aggressive Mature B-Cell Lymphomas',
  'Pediatric Central Nervous System Cancers',
  'Pediatric Hodgkin Lymphoma',
  'Penile Cancer',
  'Prostate Cancer',
  'Rectal Cancer',
  'Small Bowel Adenocarcinoma',
  'Small Cell Lung Cancer',
  'Soft Tissue Sarcoma',
  'Squamous Cell Skin Cancer',
  'Systemic Light Chain Amyloidosis',
  'Systemic Mastocytosis',
  'T-Cell Lymphomas',
  'Testicular Cancer',
  'Thymomas and Thymic Carcinomas',
  'Thyroid Carcinoma',
  'Uterine Neoplasms',
  'Vaginal Cancer',
  'Vulvar Cancer',
  'Waldenström Macroglobulinemia/Lymphoplasmacytic Lymphoma',
  'Wilms Tumor (Nephroblastoma)',
  'Other',
];

const generateCaseName = async (cancerType: string): Promise<string> => {
  if (!cancerType) return '';
  
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const dateStr = `${day}${month}${year}`;
  
  // Count cases created today
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  
  const { count } = await supabase
    .from('cases')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString())
    .lt('created_at', todayEnd.toISOString());
  
  const caseNumber = (count || 0) + 1;
  // Remove spaces from cancer type
  const compactCancerType = cancerType.replace(/\s+/g, '');
  return `${compactCancerType}-${dateStr}-${caseNumber}`;
};

export function NewCaseStep1() {
  const navigate = useNavigate();
  const { step1Data, setStep1Data, clearAll } = useCaseCreation();
  const isMobile = useIsMobile();
  const [formData, setFormData] = useState({
    caseName: step1Data?.caseName || '',
    patientName: step1Data?.patientName || '',
    age: step1Data?.age || '',
    sex: step1Data?.sex || '',
    cancerType: step1Data?.cancerType || '',
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isNewCase, setIsNewCase] = useState(!step1Data);

  // Only clear data when starting a completely new case (not coming back from step 2)
  useEffect(() => {
    // Check if we're coming back from step 2 or starting fresh
    const fromStep2 = sessionStorage.getItem('fromStep2');
    if (fromStep2) {
      sessionStorage.removeItem('fromStep2');
      setIsNewCase(false);
    }
  }, []);

  // Auto-generate case name when cancer type changes (only for new cases or when cancer type changes)
  useEffect(() => {
    const generateName = async () => {
      if (formData.cancerType && isNewCase) {
        const generatedName = await generateCaseName(formData.cancerType);
        setFormData(prev => ({ ...prev, caseName: generatedName }));
      }
    };
    generateName();
  }, [formData.cancerType, isNewCase]);

  const isCaseNameUnique = async (caseName: string): Promise<boolean> => {
    const { data, error: dbError } = await supabase
      .from('cases')
      .select('id')
      .eq('case_name', caseName)
      .maybeSingle();
    
    if (dbError) throw dbError;
    return !data; // Returns true if no case with this name exists
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
      
      // Save to context instead of sessionStorage
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
      <div className="max-w-2xl mx-auto">
        <div className={isMobile ? 'mb-4' : 'mb-6'}>
          <h1 className={`font-bold text-gray-900 ${isMobile ? 'text-xl' : 'text-2xl'}`}>Add New Case</h1>
          <p className={`text-gray-600 mt-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>Step 1 of 2: Patient Information</p>
        </div>

        <div className={`bg-white rounded-lg shadow ${isMobile ? 'p-4' : 'p-6'}`}>
          <form onSubmit={handleSubmit} className={isMobile ? 'space-y-4' : 'space-y-6'}>
            {error && <div className={`p-4 bg-red-50 border border-red-200 text-red-700 rounded-md ${isMobile ? 'text-xs p-3' : 'text-sm'}`}>{error}</div>}
            
            <div>
              <label htmlFor="patientName" className="block text-sm font-medium text-gray-700 mb-1">
                Patient Name (Optional)
              </label>
              <input
                id="patientName"
                type="text"
                value={formData.patientName}
                onChange={(e) => setFormData({ ...formData, patientName: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                style={{ fontSize: '16px' }}
                placeholder="Leave empty for anonymous"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="age" className="block text-sm font-medium text-gray-700 mb-1">
                  Age <span className="text-red-500">*</span>
                </label>
                <input
                  id="age"
                  type="number"
                  value={formData.age}
                  onChange={(e) => setFormData({ ...formData, age: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label htmlFor="sex" className="block text-sm font-medium text-gray-700 mb-1">
                  Sex <span className="text-red-500">*</span>
                </label>
                <select
                  id="sex"
                  value={formData.sex}
                  onChange={(e) => setFormData({ ...formData, sex: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              <label htmlFor="cancerType" className="block text-sm font-medium text-gray-700 mb-1">
                Cancer Type <span className="text-red-500">*</span>
              </label>
              <input
                id="cancerType"
                type="text"
                list="cancerTypesList"
                value={formData.cancerType}
                onChange={(e) => setFormData({ ...formData, cancerType: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Type or select cancer type"
                required
              />
              <datalist id="cancerTypesList">
                {cancerTypes.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
              <p className="text-xs text-gray-500 mt-1">Start typing to see suggestions or enter your own</p>
            </div>

            <div>
              <label htmlFor="caseName" className="block text-sm font-medium text-gray-700 mb-1">
                Case Name <span className="text-red-500">*</span>
              </label>
              <input
                id="caseName"
                type="text"
                value={formData.caseName}
                onChange={(e) => setFormData({ ...formData, caseName: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Auto-generated based on cancer type"
                required
              />
              <p className="text-xs text-gray-500 mt-1">Auto-generated from cancer type and date. You can modify if needed.</p>
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  clearAll();
                  navigate('/my-cases');
                }}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Validating...' : 'Next'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  );
}
