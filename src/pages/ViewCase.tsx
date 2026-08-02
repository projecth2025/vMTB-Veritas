import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { MessageSquare, Edit2, Trash2, CheckCircle, Plus, X, ArrowLeft, AlertTriangle, Filter, ChevronDown, Check } from 'lucide-react';
import { marked } from 'marked';
import TurndownService from 'turndown';
import DOMPurify from 'dompurify';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { EditorToolbar } from '../components/EditorToolbar';
import { Reports } from '../components/Reports';
import { VerifyModal } from '../components/VerifyModal';
import { OpinionComment } from '../components/OpinionComment';
import { InlineOpinionInput } from '../components/InlineOpinionInput';
import { TreatmentPlanFollowUp } from '../components/TreatmentPlanFollowUp';
import { useCases, Case, Opinion, Question } from '../context/CasesContext';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';

type TabType = 'summary' | 'reports' | 'opinions' | 'treatmentfollowup' | 'settings';

export function ViewCase() {
  const { id, mtbId: mtbIdFromPath } = useParams<{ id: string; mtbId?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { getCaseById, updateCase, addOpinion, updateOpinion, deleteCase, verifySummary, addFollowUp, removeCaseFromMTB } = useCases();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [caseData, setCaseData] = useState<Case | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('summary');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showRemoveFromMTBModal, setShowRemoveFromMTBModal] = useState(false);
  const [removingFromMTB, setRemovingFromMTB] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [renderedHTML, setRenderedHTML] = useState('');
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyingProgress, setVerifyingProgress] = useState(false);
  const [showEditPatientModal, setShowEditPatientModal] = useState(false);
  const [savingPatientDetails, setSavingPatientDetails] = useState(false);
  const [patientDetailsError, setPatientDetailsError] = useState<string | null>(null);
  const [patientForm, setPatientForm] = useState({
    caseName: '',
    patientName: '',
    age: '',
    sex: '',
    cancerType: '',
  });
  
  // Opinions page state (inline, no modals)
  const [showAddQuestionModal, setShowAddQuestionModal] = useState(false);
  const [newQuestionText, setNewQuestionText] = useState('');
  const [addingQuestion, setAddingQuestion] = useState(false);
  const [opinionMtbs, setOpinionMtbs] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedOpinionMtbId, setSelectedOpinionMtbId] = useState<string | null>(null);
  const [opinionsLoading, setOpinionsLoading] = useState(false);
  const [showMtbFilterMenu, setShowMtbFilterMenu] = useState(false);
  
  // Ref for contenteditable div
  const editorRef = useRef<HTMLDivElement>(null);
  const verifyButtonRef = useRef<HTMLDivElement>(null);
  const mtbFilterMenuRef = useRef<HTMLDivElement>(null);

  // Initialize Turndown service for HTML to Markdown conversion
  const turndownService = useRef(
    new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced'
    })
  );

  // Configure marked options
  useEffect(() => {
    marked.setOptions({
      breaks: true, // Convert line breaks to <br>
      gfm: true // GitHub Flavored Markdown
    });
  }, []);

  // Convert markdown to HTML when summary changes
  useEffect(() => {
    if (caseData?.summary) {
      const html = marked.parse(caseData.summary) as string;
      const sanitized = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'br'],
        ALLOWED_ATTR: []
      });
      setRenderedHTML(sanitized);
    } else {
      setRenderedHTML('');
    }
  }, [caseData?.summary]);

  // Handle toolbar formatting commands
  const handleFormat = (command: string, value?: string) => {
    if (value) {
      document.execCommand(command, false, value);
    } else {
      document.execCommand(command, false);
    }
    // Keep focus on editor
    editorRef.current?.focus();
  };

  // Handle paste to strip formatting and keep only plain text
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!editingSummary) return;
    
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  };

  const isOwner = caseData?.ownerId === user?.id;
  const viewMode = isOwner ? 'owner' : 'visitor';
  const isProcessingSummary = caseData?.summary === null || caseData?.summary === undefined;
  const mtbIdFromQuery = searchParams.get('mtbId');
  const currentMtbId = mtbIdFromPath || mtbIdFromQuery || null;
  const fromMTB = searchParams.get('from') === 'mtb' || Boolean(currentMtbId);
  const activeOpinionMtbId = selectedOpinionMtbId || currentMtbId;
  const showCompactMtbFilter = Boolean(isOwner && opinionMtbs.length > 1);
  const activeOpinionMtbName = opinionMtbs.find(m => m.id === activeOpinionMtbId)?.name || '';

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!mtbFilterMenuRef.current) return;
      if (!mtbFilterMenuRef.current.contains(event.target as Node)) {
        setShowMtbFilterMenu(false);
      }
    };

    if (showMtbFilterMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMtbFilterMenu]);

  const fetchSharedMtbsForCase = async (caseId: string): Promise<Array<{ id: string; name: string }>> => {
    const { data, error } = await supabase
      .from('mtb_cases')
      .select('mtb_id, mtbs(id, name)')
      .eq('case_id', caseId);

    if (error) throw error;

    const parsed = (data || [])
      .map((row: any) => {
        const mtb = Array.isArray(row.mtbs) ? row.mtbs[0] : row.mtbs;
        return mtb?.id && mtb?.name ? { id: mtb.id as string, name: mtb.name as string } : null;
      })
      .filter(Boolean) as Array<{ id: string; name: string }>;

    return Array.from(new Map(parsed.map(m => [m.id, m])).values());
  };

  const refreshCaseData = async (mtbId: string | null, showOpinionLoading = false) => {
    if (!id) return;
    if (showOpinionLoading) setOpinionsLoading(true);
    try {
      const data = await getCaseById(id, mtbId ? { mtbId } : undefined);
      setCaseData(data);
    } catch (err) {
      console.error('Failed to refresh case:', err);
    } finally {
      if (showOpinionLoading) setOpinionsLoading(false);
    }
  };

  useEffect(() => {
    const fetchCase = async () => {
      if (!id) return;
      setLoading(true);
      try {
        const baseData = await getCaseById(id);
        setCaseData(baseData);

        if (!baseData) return;

        let defaultMtbId: string | null = currentMtbId;
        if (baseData.ownerId === user?.id) {
          const sharedMtbs = await fetchSharedMtbsForCase(id);
          setOpinionMtbs(sharedMtbs);

          if (currentMtbId && sharedMtbs.some(m => m.id === currentMtbId)) {
            defaultMtbId = currentMtbId;
          } else {
            defaultMtbId = sharedMtbs[0]?.id || null;
          }
        } else {
          setOpinionMtbs([]);
          defaultMtbId = currentMtbId;
        }

        setSelectedOpinionMtbId(defaultMtbId);

        if (defaultMtbId) {
          const filteredData = await getCaseById(id, { mtbId: defaultMtbId });
          setCaseData(filteredData);
        } else {
          setCaseData(prev => (prev ? { ...prev, opinions: [] } : prev));
        }
      } catch (err) {
        console.error('Failed to fetch case:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchCase();
  }, [id, user?.id, getCaseById, currentMtbId]);

  useEffect(() => {
    if (!caseData) return;
    setPatientForm({
      caseName: caseData.caseName || '',
      patientName: caseData.patientName || '',
      age: caseData.age ? String(caseData.age) : '',
      sex: caseData.sex || '',
      cancerType: caseData.cancerType || '',
    });
  }, [caseData]);

  // Poll backend for processing cases to auto-refresh summary/status
  useEffect(() => {
    if (!id) return;
    if (caseData?.summaryStatus !== 'processing') return;

    const interval = setInterval(async () => {
      try {
        const data = await getCaseById(id, activeOpinionMtbId ? { mtbId: activeOpinionMtbId } : undefined);
        if (data) {
          // Preserve currently loaded MTB discussion slice while refreshing summary status.
          setCaseData(prev => prev ? {
            ...prev,
            summary: data.summary,
            summaryStatus: data.summaryStatus,
            reportStatus: data.reportStatus,
            treatmentPlan: data.treatmentPlan,
          } : data);
          // Stop polling once processing completes
          if (data.summaryStatus !== 'processing') {
            clearInterval(interval);
          }
        }
      } catch (err) {
        console.error('Failed to refresh case status:', err);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [id, caseData?.summaryStatus, getCaseById, activeOpinionMtbId]);

  const handleSaveSummary = async () => {
    if (!id || !isOwner || !editorRef.current) return;
    setSavingSummary(true);
    try {
      // Get HTML from contenteditable
      const html = editorRef.current.innerHTML;
      
      // Sanitize HTML
      const cleanHTML = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'br'],
        ALLOWED_ATTR: []
      });
      
      // Convert HTML to Markdown
      const markdown = turndownService.current.turndown(cleanHTML);
      
      // Save to Supabase
      await updateCase(id, { summary: markdown });
      
      // Refetch case
      await refreshCaseData(activeOpinionMtbId || null);
      setEditingSummary(false);
    } catch (err) {
      console.error('Failed to save summary:', err);
    } finally {
      setSavingSummary(false);
    }
  };

  const handleVerifySummary = async () => {
    if (!id || !isOwner) return;
    setVerifyingProgress(true);
    try {
      await verifySummary(id);
      setShowVerifyModal(false);
      // Refetch case to show updated status
      await refreshCaseData(activeOpinionMtbId || null);
    } catch (err) {
      console.error('Failed to verify summary:', err);
    } finally {
      setVerifyingProgress(false);
    }
  };

  const openEditPatientModal = () => {
    if (!caseData) return;
    setPatientDetailsError(null);
    setPatientForm({
      caseName: caseData.caseName || '',
      patientName: caseData.patientName || '',
      age: caseData.age ? String(caseData.age) : '',
      sex: caseData.sex || '',
      cancerType: caseData.cancerType || '',
    });
    setShowEditPatientModal(true);
  };

  const handlePatientFieldChange = (field: 'caseName' | 'patientName' | 'age' | 'sex' | 'cancerType', value: string) => {
    setPatientForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSavePatientDetails = async () => {
    if (!id || !isOwner || !caseData) return;

    const parsedAge = Number.parseInt(patientForm.age, 10);
    if (!patientForm.caseName.trim()) {
      setPatientDetailsError('Case name is required.');
      return;
    }
    if (!Number.isFinite(parsedAge) || parsedAge <= 0) {
      setPatientDetailsError('Please enter a valid age.');
      return;
    }
    if (!patientForm.sex.trim()) {
      setPatientDetailsError('Sex is required.');
      return;
    }
    if (!patientForm.cancerType.trim()) {
      setPatientDetailsError('Cancer type is required.');
      return;
    }

    setSavingPatientDetails(true);
    setPatientDetailsError(null);
    try {
      const updates: Partial<Case> = {
        caseName: patientForm.caseName.trim(),
        patientName: patientForm.patientName.trim(),
        age: parsedAge,
        sex: patientForm.sex.trim(),
        cancerType: patientForm.cancerType.trim(),
      };

      await updateCase(id, updates);
      setCaseData(prev => (prev ? { ...prev, ...updates } : prev));
      setShowEditPatientModal(false);
      showToast.success('Patient details updated successfully.');
    } catch (err) {
      console.error('Failed to update patient details:', err);
      setPatientDetailsError('Failed to save patient details. Please try again.');
    } finally {
      setSavingPatientDetails(false);
    }
  };

  // Inline opinion submission handlers
  const handleSubmitGeneralOpinion = async (content: string) => {
    if (!id) return;
    if (!activeOpinionMtbId) {
      showToast.error('Select an MTB context to post opinions.');
      return;
    }
    await addOpinion(id, content, null, null, activeOpinionMtbId);
    await refreshCaseData(activeOpinionMtbId);
  };

  const handleSubmitQuestionOpinion = async (questionId: string, content: string) => {
    if (!id) return;
    if (!activeOpinionMtbId) {
      showToast.error('Select an MTB context to post opinions.');
      return;
    }
    await addOpinion(id, content, questionId, null, activeOpinionMtbId);
    await refreshCaseData(activeOpinionMtbId);
  };

  const handleSubmitReply = async (parentId: string, questionId: string | null, content: string) => {
    if (!id) return;
    if (!activeOpinionMtbId) {
      showToast.error('Select an MTB context to post replies.');
      return;
    }
    await addOpinion(id, content, questionId, parentId, activeOpinionMtbId);
    await refreshCaseData(activeOpinionMtbId);
  };

  const handleAddQuestion = async () => {
    if (!id || !newQuestionText.trim()) return;
    
    setAddingQuestion(true);
    try {
      await supabase.from('case_questions').insert({
        case_id: id,
        question_text: newQuestionText.trim(),
      });
      
      // Refetch case
      await refreshCaseData(activeOpinionMtbId || null);
      
      setNewQuestionText('');
      setShowAddQuestionModal(false);
    } catch (err) {
      console.error('Failed to add question:', err);
      showToast.error('Failed to add question. Please try again.');
    } finally {
      setAddingQuestion(false);
    }
  };

  const handleDeleteCase = async () => {
    if (!id || !isOwner) return;
    setDeleting(true);
    try {
      await deleteCase(id);
      navigate('/my-cases');
    } catch (err) {
      console.error('Failed to delete case:', err);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const scrollToVerifyButton = () => {
    verifyButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const canPostOpinions = Boolean(activeOpinionMtbId) && (isOwner || fromMTB);

  // Handle removing case from MTB
  const handleRemoveFromMTB = async () => {
    if (!currentMtbId || !id) return;
    setRemovingFromMTB(true);
    try {
      await removeCaseFromMTB(currentMtbId, id);
      showToast.success('Case removed from MTB');
      navigate(`/mtb/${currentMtbId}`);
    } catch (err) {
      console.error('Failed to remove case from MTB:', err);
      showToast.error('Failed to remove case from MTB');
    } finally {
      setRemovingFromMTB(false);
      setShowRemoveFromMTBModal(false);
    }
  };

  const handleSelectOpinionMtb = async (nextMtbId: string) => {
    setSelectedOpinionMtbId(nextMtbId);
    setShowMtbFilterMenu(false);
    await refreshCaseData(nextMtbId, true);
  };

  if (loading) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-gray-600">Loading case...</p>
        </div>
      </Layout>
    );
  }

  if (!caseData) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-gray-600">Case not found</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout wide>
      <div className="w-full flex justify-center">
        <div className="w-full">
          {/* Back Arrow + Tab Navigation in one row */}
          <div className={`border-b border-gray-200 ${isMobile ? 'mb-4' : 'mb-6'}`}>
            <nav className={`-mb-px flex items-center ${isMobile ? 'overflow-x-auto no-scrollbar gap-1' : 'gap-6'}`}>
              <button
                onClick={() => navigate(-1)}
                className="flex-shrink-0 mr-2 text-gray-500 hover:text-gray-900 transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              {(['summary', 'reports', 'opinions', 'treatmentfollowup', 'settings'] as TabType[]).map((tab) => {
                const isDisabled = tab !== 'summary' && tab !== 'settings' && caseData?.summaryStatus !== 'verified';
                const tabLabel = isMobile 
                  ? (tab === 'summary' ? 'Summary' : 
                     tab === 'reports' ? 'Reports' :
                     tab === 'opinions' ? 'Opinions' :
                     tab === 'treatmentfollowup' ? 'Treatment' :
                     'Settings')
                  : (tab === 'summary' ? 'Case Summary' : 
                     tab === 'reports' ? 'Reports' :
                     tab === 'opinions' ? 'Opinions' :
                     tab === 'treatmentfollowup' ? 'Treatment Plan & Follow-Up' :
                     'Case Settings');
                return (
                  <button
                    key={tab}
                    onClick={() => {
                      if (isDisabled) {
                        showToast.warning('Please verify the case summary first to access this section');
                        return;
                      }
                      setActiveTab(tab);
                    }}
                    className={`border-b-2 font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                      isMobile ? 'py-2.5 px-2 text-xs' : 'py-3 px-0.5 text-sm'
                    } ${
                      isDisabled
                        ? 'border-transparent text-gray-300 cursor-pointer'
                        : activeTab === tab
                        ? 'text-blue-600' + ' border-blue-500'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {tabLabel}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Tab Content */}
          {activeTab === 'reports' ? (
            <Reports caseData={caseData} isOwner={isOwner} />
          ) : (
            <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
              {/* === CASE SUMMARY TAB === */}
              {activeTab === 'summary' && (
                <>
                  {/* Patient Information Card */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-base font-semibold" style={{ color: '#4A5565' }}>
                        Patient Information — <span className="text-gray-700">"{caseData.caseName}"</span>
                      </h3>
                      <div className="flex items-center gap-2">
                        {isOwner && (
                          <span className="px-3 py-1 text-xs font-medium rounded-full bg-blue-50 text-blue-600">
                            You
                          </span>
                        )}
                        {isOwner && (
                          <button
                            onClick={openEditPatientModal}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-gray-600 bg-gray-50 border border-gray-200 hover:bg-gray-100 transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <div className={`grid ${isMobile ? 'grid-cols-2 gap-4' : 'grid-cols-4 gap-6'}`}>
                      {!fromMTB && (
                        <div>
                          <p className="text-xs text-gray-400 mb-1">Name</p>
                          <p className="text-sm font-medium" style={{ color: '#4A5565' }}>{caseData.patientName || 'Anonymous'}</p>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-gray-400 mb-1">Age</p>
                        <p className="text-sm font-medium" style={{ color: '#4A5565' }}>{caseData.age} years</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 mb-1">Sex</p>
                        <p className="text-sm font-medium" style={{ color: '#4A5565' }}>{caseData.sex}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 mb-1">Cancer Type</p>
                        <p className="text-sm font-medium" style={{ color: '#4A5565' }}>{caseData.cancerType}</p>
                      </div>
                    </div>
                  </div>

                  {/* Case Summary Card */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-base font-semibold" style={{ color: '#4A5565' }}>Case Summary</h3>
                      <div className="flex items-center gap-2">
                        {/* Verified badge */}
                        {caseData?.summaryStatus === 'verified' && (
                          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-green-50 text-green-700 border border-green-200">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Verified & Shared
                          </span>
                        )}
                        {/* Edit button - only when unverified and owner */}
                        {!isProcessingSummary && isOwner && !editingSummary && caseData?.summaryStatus !== 'verified' && (
                          <button
                            onClick={() => setEditingSummary(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-gray-600 bg-gray-50 border border-gray-200 hover:bg-gray-100 transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                        )}
                      </div>
                    </div>

            {/* Verification Reminder Banner - Only for owner when unverified */}
            {isOwner && caseData?.summaryStatus === 'unverified' && !editingSummary && (
              <div className="mb-4"> </div>
            )}

            {isProcessingSummary ? (
              <div className="space-y-3">
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                  <p className="text-sm font-medium text-yellow-800 mb-2">
                    ⏳ Summary is being generated
                  </p>
                  <p className="text-sm text-yellow-700">
                    This may take up to 5 minutes. Please refresh the page after some time to see the summary.
                  </p>
                </div>
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm"
                >
                  Refresh Page
                </button>
              </div>
            ) : (
              <>
                {/* Toolbar - Only visible when editing */}
                {editingSummary && <EditorToolbar onFormat={handleFormat} />}
                
                {/* Editable Summary */}
                <div
                  ref={editorRef}
                  contentEditable={editingSummary}
                  suppressContentEditableWarning
                  onPaste={handlePaste}
                  className={`summary-editor bg-gray-50 p-6 rounded-md border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[200px] ${
                    editingSummary ? 'rounded-t-none' : ''
                  }`}
                  style={{
                    cursor: editingSummary ? 'text' : 'default'
                  }}
                  dangerouslySetInnerHTML={{ __html: renderedHTML || '<p class="text-gray-500">No summary yet...</p>' }}
                />
                
                {/* Action Buttons - Only visible when editing */}
                {editingSummary && (
                  <div className="flex space-x-2 mt-4">
                    <button
                      onClick={handleSaveSummary}
                      disabled={savingSummary}
                      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingSummary ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button
                      onClick={() => {
                        // Reset to original HTML
                        if (caseData?.summary) {
                          const html = marked.parse(caseData.summary) as string;
                          const sanitized = DOMPurify.sanitize(html, {
                            ALLOWED_TAGS: ['p', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'br'],
                            ALLOWED_ATTR: []
                          });
                          setRenderedHTML(sanitized);
                        }
                        setEditingSummary(false);
                      }}
                      className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Verification Box - Only for owner when summary is unverified */}
                {isOwner && caseData?.summaryStatus === 'unverified' && !editingSummary && (
                  <div ref={verifyButtonRef} className="mt-5 p-4 bg-orange-50 border border-orange-200 rounded-lg">
                    <div className={`flex ${isMobile ? 'flex-col gap-3' : 'items-center justify-between'}`}>
                      <div>
                        <p className="text-sm font-semibold text-orange-800">Verification Required</p>
                        <p className="text-xs text-orange-700 mt-0.5">
                          Please verify this case summary to unlock Reports, Opinions, and Treatment sections.
                        </p>
                      </div>
                      <button
                        onClick={() => setShowVerifyModal(true)}
                        className={`flex-shrink-0 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity ${isMobile ? 'w-full text-center' : ''}`}
                        style={{ backgroundColor: '#4A90E2' }}
                      >
                        Verify Case Summary
                      </button>
                    </div>
                  </div>
                )}
                
                {/* Verified metadata - Show when verified */}
                {caseData?.summaryStatus === 'verified' && !editingSummary && (
                  <div className="mt-5 pt-4 border-t border-gray-100">
                    <p className="text-xs text-gray-400">
                      Verified by: <span className="text-gray-500 font-medium">{user?.email || 'Doctor'}</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {caseData.createdDate ? new Date(caseData.createdDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

            </>
          )}

          {/* === CASE SETTINGS TAB === */}
          {activeTab === 'settings' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold" style={{ color: '#4A5565' }}>Case Settings</h2>
              
              {/* Remove from MTB - only visible when viewing from MTB context and user owns the case */}
              {fromMTB && currentMtbId && isOwner && (
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                  <h3 className="text-sm font-semibold mb-2" style={{ color: '#4A5565' }}>Remove from MTB</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Remove this case from the current MTB. The case will no longer be visible to MTB members.
                  </p>
                  <button
                    onClick={() => setShowRemoveFromMTBModal(true)}
                    className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <X className="w-4 h-4" />
                    <span>Remove from MTB</span>
                  </button>
                </div>
              )}

              {/* Delete Case - Owner Only */}
              {isOwner && (
                <div className="bg-white rounded-xl shadow-sm border border-red-100 p-6">
                  <h3 className="text-sm font-semibold text-red-700 mb-2">Danger Zone</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Permanently delete this case and all associated data. This action cannot be undone.
                  </p>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Delete Case</span>
                  </button>
                </div>
              )}

              {!isOwner && (
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 text-center">
                  <p className="text-sm text-gray-500">No settings available. Only the case owner can manage case settings.</p>
                </div>
              )}
            </div>
          )}

          {/* === OPINIONS TAB === */}
          {activeTab === 'opinions' && (
            <>
              {!activeOpinionMtbId && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">
                  <p className="text-sm text-gray-600">No MTB selected for discussions.</p>
                </div>
              )}

              {opinionsLoading ? (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
                  <p className="text-sm text-gray-500">Loading discussions...</p>
                </div>
              ) : (
              <>
              {/* Two Column Layout */}
              <div className={`${isMobile ? 'flex flex-col gap-5' : 'grid gap-6'}`} style={!isMobile ? { gridTemplateColumns: '3fr 2fr' } : undefined}>

                {/* ===== LEFT COLUMN — General Opinions ===== */}
                <div className="flex flex-col gap-4">
                  <h3 className="text-base font-semibold" style={{ color: '#4A5565' }}>General Opinions</h3>

                  {/* Opinion Input Card */}
                  {canPostOpinions && (
                    <InlineOpinionInput
                      onSubmit={handleSubmitGeneralOpinion}
                      placeholder="Write your opinion..."
                      variant="card"
                    />
                  )}

                  {/* Opinion Feed */}
                  {(() => {
                    const generalOpinions = (caseData.opinions || [])
                      .filter(o => o.questionId === null && o.parentId === null)
                      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

                    return generalOpinions.length > 0 ? (
                      <div className="space-y-3">
                        {generalOpinions.map(opinion => (
                          <OpinionComment
                            key={opinion.id}
                            opinion={opinion}
                            allOpinions={caseData.opinions || []}
                            depth={0}
                            onReply={handleSubmitReply}
                            currentUserId={user?.id}
                            canReply={canPostOpinions}
                            ownerId={caseData.ownerId}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
                        <MessageSquare className="w-8 h-8 text-gray-200 mx-auto mb-3" />
                        <p className="text-sm text-gray-400">No discussions yet in this MTB.</p>
                      </div>
                    );
                  })()}
                </div>

                {/* ===== RIGHT COLUMN — Specific Questions ===== */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-semibold" style={{ color: '#4A5565' }}>Specific Questions</h3>
                    <div className="flex items-center gap-2">
                      {showCompactMtbFilter && (
                        <div className="relative" ref={mtbFilterMenuRef}>
                          <button
                            type="button"
                            onClick={() => setShowMtbFilterMenu(prev => !prev)}
                            title={activeOpinionMtbName ? `Current MTB: ${activeOpinionMtbName}` : 'Select MTB'}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                            disabled={opinionsLoading}
                          >
                            <Filter className="w-3.5 h-3.5" />
                            <span>MTB</span>
                            <ChevronDown className="w-3 h-3" />
                          </button>

                          {showMtbFilterMenu && (
                            <div className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                              {opinionMtbs.map((mtb) => {
                                const isActive = mtb.id === activeOpinionMtbId;
                                return (
                                  <button
                                    key={mtb.id}
                                    type="button"
                                    onClick={() => handleSelectOpinionMtb(mtb.id)}
                                    className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-50 ${isActive ? 'text-blue-700 bg-blue-50' : 'text-gray-700'}`}
                                  >
                                    <span className="truncate pr-2">{mtb.name}</span>
                                    {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {isOwner && (
                        <button
                          onClick={() => setShowAddQuestionModal(true)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-white hover:opacity-90 transition-opacity"
                          style={{ backgroundColor: '#4A90E2' }}
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Ask Question</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Questions List */}
                  {caseData.questions && caseData.questions.length > 0 ? (
                    <div className="space-y-4">
                      {caseData.questions.map((question) => {
                        const questionOpinions = (caseData.opinions || [])
                          .filter(o => o.questionId === question.id && o.parentId === null)
                          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

                        return (
                          <div key={question.id} className="bg-white rounded-xl shadow-sm border border-gray-100">
                            {/* Question Header */}
                            <div className="px-5 py-4 border-b border-gray-100">
                              <p className="text-sm font-semibold text-gray-900 leading-snug">{question.text}</p>
                              <div className="flex items-center gap-2 mt-2">
                                <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-50 text-blue-600">Clinical</span>
                                <span className="text-xs text-gray-400">Asked by Case Owner</span>
                              </div>
                            </div>

                            {/* Answers */}
                            <div className="px-5 py-3">
                              {questionOpinions.length > 0 ? (
                                <div className="space-y-2">
                                  {questionOpinions.map(opinion => (
                                    <OpinionComment
                                      key={opinion.id}
                                      opinion={opinion}
                                      allOpinions={caseData.opinions || []}
                                      depth={0}
                                      onReply={handleSubmitReply}
                                      currentUserId={user?.id}
                                      canReply={canPostOpinions}
                                      ownerId={caseData.ownerId}
                                      compact
                                    />
                                  ))}
                                </div>
                              ) : (
                                <p className="text-xs text-gray-400 py-2">No answers yet.</p>
                              )}

                              {/* Answer Input */}
                              {canPostOpinions && (
                                <InlineOpinionInput
                                  onSubmit={(content) => handleSubmitQuestionOpinion(question.id, content)}
                                  placeholder="Write your answer..."
                                  variant="inline"
                                  submitLabel="Answer"
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
                      <MessageSquare className="w-8 h-8 text-gray-200 mx-auto mb-3" />
                      <p className="text-sm text-gray-400">
                        {isOwner
                          ? 'No questions yet. Add questions to guide expert discussions.'
                          : 'No questions have been added by the case owner yet.'}
                      </p>
                    </div>
                  )}
                </div>

              </div>
              </>
              )}
            </>
          )}

          {/* === TREATMENT PLAN & FOLLOW-UP TAB === */}
          {activeTab === 'treatmentfollowup' && (
            <TreatmentPlanFollowUp caseId={id!} isOwner={isOwner} />
          )}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showEditPatientModal}
        onClose={() => {
          if (!savingPatientDetails) {
            setShowEditPatientModal(false);
            setPatientDetailsError(null);
          }
        }}
        title="Edit Patient Details"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Case Name</label>
            <input
              type="text"
              value={patientForm.caseName}
              onChange={(e) => handlePatientFieldChange('caseName', e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={savingPatientDetails}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Patient Name</label>
            <input
              type="text"
              value={patientForm.patientName}
              onChange={(e) => handlePatientFieldChange('patientName', e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={savingPatientDetails}
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Age</label>
              <input
                type="number"
                min={1}
                value={patientForm.age}
                onChange={(e) => handlePatientFieldChange('age', e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={savingPatientDetails}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Sex</label>
              <input
                type="text"
                value={patientForm.sex}
                onChange={(e) => handlePatientFieldChange('sex', e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={savingPatientDetails}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Cancer Type</label>
            <input
              type="text"
              value={patientForm.cancerType}
              onChange={(e) => handlePatientFieldChange('cancerType', e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={savingPatientDetails}
            />
          </div>

          {patientDetailsError && (
            <div className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">
              {patientDetailsError}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <button
              onClick={() => {
                if (!savingPatientDetails) {
                  setShowEditPatientModal(false);
                  setPatientDetailsError(null);
                }
              }}
              disabled={savingPatientDetails}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSavePatientDetails}
              disabled={savingPatientDetails}
              className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {savingPatientDetails ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete Case"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            This case will be permanently deleted and cannot be recovered. All associated documents, opinions, and questions will also be removed.
          </p>
          <p className="text-sm font-medium text-gray-900">Do you want to continue?</p>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteCase}
              disabled={deleting}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete Case'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Verify Summary Modal */}
      <VerifyModal
        isOpen={showVerifyModal}
        onConfirm={handleVerifySummary}
        onCancel={() => setShowVerifyModal(false)}
        isLoading={verifyingProgress}
      />

      {/* Add Question Modal */}
      <Modal
        isOpen={showAddQuestionModal}
        onClose={() => {
          setShowAddQuestionModal(false);
          setNewQuestionText('');
        }}
        title="Add New Question"
      >
        <div className="space-y-4">
          <textarea
            value={newQuestionText}
            onChange={(e) => setNewQuestionText(e.target.value)}
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter your question for the experts..."
            autoFocus
          />

          <div className="flex justify-end space-x-3">
            <button
              onClick={() => {
                setShowAddQuestionModal(false);
                setNewQuestionText('');
              }}
              disabled={addingQuestion}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleAddQuestion}
              disabled={addingQuestion || !newQuestionText.trim()}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {addingQuestion ? 'Adding...' : 'Add Question'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Remove from MTB Confirmation Modal */}
      <Modal
        isOpen={showRemoveFromMTBModal}
        onClose={() => setShowRemoveFromMTBModal(false)}
        title="Remove Case from MTB"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Are you sure you want to remove this case from the MTB? The case will no longer be visible to MTB members.
          </p>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowRemoveFromMTBModal(false)}
              disabled={removingFromMTB}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleRemoveFromMTB}
              disabled={removingFromMTB}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {removingFromMTB ? 'Removing...' : 'Remove'}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
