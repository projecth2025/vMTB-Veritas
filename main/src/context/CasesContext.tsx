import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { supabase } from '../Supabase/client';
import { useAuth } from './AuthContext';

export type SummaryStatus = 'processing' | 'unverified' | 'verified' | 'failed';
export type ReportStatus = 'not_ready' | 'unverified' | 'verified';

export interface Question {
  id: string;
  text: string;
}

export interface Case {
  id: string;
  caseName: string;
  patientName?: string;
  age: number;
  sex: string;
  cancerType: string;
  createdDate: string;
  summary?: string | null;
  summaryStatus?: SummaryStatus;
  reportStatus?: ReportStatus;
  requestId?: string | null;
  questions?: Question[];
  opinions?: Opinion[];
  documents?: Document[];
  treatmentPlan?: any;
  followUps?: FollowUp[];
  ownerId?: string;
}

export interface Opinion {
  id: string;
  caseId: string;
  questionId: string | null; // NULL = general opinion, UUID = tied to question
  parentId: string | null; // NULL = top-level, UUID = reply to another opinion
  mtbId: string | null;
  authorUserId: string;
  content: string;
  createdAt: string;
}

interface GetCaseByIdOptions {
  mtbId?: string | null;
  includeLegacyWhenNoMtbSpecific?: boolean;
}

export interface Document {
  id: string;
  name: string;
  size: string;
  type: 'NGS' | 'Clinical' | 'Text';
  storagePath?: string;
  mimeType?: string;
}

export interface FollowUp {
  id: string;
  caseId: string;
  followUp: string;
  createdAt: string;
  createdBy: string;
}

export interface MTB {
  id: string;
  name: string;
  experts: number;
  cases: string[];
  ownerId?: string;
  joinCode?: string;
  notificationEnabled?: boolean;
}

interface CasesContextType {
  cases: Case[];
  mtbs: MTB[];
  loading: boolean;
  refetchCases: () => Promise<void>;
  refetchMTBs: () => Promise<void>;
  refreshProcessingCases: () => Promise<void>;
  createCase: (
    caseData: Omit<Case, 'id' | 'createdDate' | 'ownerId'> & { requestId?: string },
    documents: Document[],
    questions: string[],
    shareWithMtbIds?: string[],
  ) => Promise<{ caseId: string; createdAt: string }>;
  updateCase: (id: string, updates: Partial<Case>) => Promise<void>;
  deleteCase: (id: string) => Promise<void>;
  verifySummary: (caseId: string) => Promise<void>;
  verifyReport: (caseId: string) => Promise<void>;
  createMTB: (name: string) => Promise<void>;
  joinMTB: (joinCode: string) => Promise<void>;
  leaveMTB: (mtbId: string) => Promise<void>;
  addCaseToMTB: (mtbId: string, caseId: string) => Promise<void>;
  removeCaseFromMTB: (mtbId: string, caseId: string) => Promise<void>;
  updateMTBName: (mtbId: string, newName: string) => Promise<void>;
  updateMTBNotification: (mtbId: string, enabled: boolean) => Promise<void>;
  addOpinion: (caseId: string, content: string, questionId?: string | null, parentId?: string | null, mtbId?: string | null) => Promise<void>;
  updateOpinion: (opinionId: string, content: string) => Promise<void>;
  addFollowUp: (caseId: string, followUp: string) => Promise<void>;
  getCaseById: (id: string, options?: GetCaseByIdOptions) => Promise<Case | null>;
}

const CasesContext = createContext<CasesContextType | undefined>(undefined);

export function CasesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [cases, setCases] = useState<Case[]>([]);
  const [mtbs, setMTBs] = useState<MTB[]>([]);
  const [loading, setLoading] = useState(false);

  const refetchCases = async () => {
    if (!user) { setCases([]); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('cases')
        .select('*')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setCases((data || []).map(row => ({
        id: row.id,
        caseName: row.case_name,
        patientName: row.patient_name,
        age: row.patient_age,
        sex: row.patient_sex,
        cancerType: row.cancer_type,
        createdDate: row.created_at.split('T')[0],
        summary: row.summary,
        summaryStatus: row.summary_status || 'processing',
        reportStatus: row.report_status || 'not_ready',
        requestId: row.request_id,
        treatmentPlan: row.treatment_plan,
        ownerId: row.owner_id,
      })));
    } catch (err) {
      console.error('Failed to fetch cases:', err);
    } finally {
      setLoading(false);
    }
  };

  // Lightweight refresh: only fetch cases that are processing in local state
  const refreshProcessingCases = async () => {
    if (!user) return;
    // Get IDs of cases that are processing in current local state
    const processingCaseIds = cases
      .filter(c => c.summaryStatus === 'processing')
      .map(c => c.id);
    
    if (processingCaseIds.length === 0) return;

    // Fetch current status of these cases (regardless of their DB status)
    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .eq('owner_id', user.id)
      .in('id', processingCaseIds);
    
    if (error) {
      console.error('Failed to refresh processing cases:', error);
      return;
    }

    if (!data || data.length === 0) return;

    // Update local state with new data (status may have changed to unverified/verified/failed)
    setCases(prev => prev.map(c => {
      const updated = data.find(row => row.id === c.id);
      if (!updated) return c;
      return {
        ...c,
        summary: updated.summary,
        summaryStatus: updated.summary_status || 'processing',
        reportStatus: updated.report_status || 'not_ready',
        treatmentPlan: updated.treatment_plan,
      };
    }));
  };

  const refetchMTBs = async () => {
    if (!user) { setMTBs([]); return; }
    setLoading(true);
    try {
      // Fetch MTBs where user is owner
      const { data: ownedMTBs, error: ownedError } = await supabase
        .from('mtbs')
        .select('*')
        .eq('owner_id', user.id);
      if (ownedError) throw ownedError;

      // Fetch MTBs where user is a member
      const { data: memberMTBs, error: memberError } = await supabase
        .from('mtb_members')
        .select('mtb_id')
        .eq('user_id', user.id);
      if (memberError) throw memberError;

      const memberMtbIds = (memberMTBs || []).map(m => m.mtb_id);
      let joinedMTBs: any[] = [];
      if (memberMtbIds.length > 0) {
        const { data, error } = await supabase.from('mtbs').select('*').in('id', memberMtbIds);
        if (error) throw error;
        joinedMTBs = data || [];
      }

      // Merge and deduplicate
      const allMTBs = [...(ownedMTBs || []), ...joinedMTBs];
      const uniqueMTBs = Array.from(new Map(allMTBs.map(m => [m.id, m])).values());

      // For each MTB, count members and cases
      const mtbsWithCounts = await Promise.all(uniqueMTBs.map(async (mtb) => {
        const { count: memberCount } = await supabase.from('mtb_members').select('*', { count: 'exact', head: true }).eq('mtb_id', mtb.id);
        // Only include verified cases for MTBs (privacy enforcement)
        const { data: mtbCases } = await supabase
          .from('mtb_cases')
          .select('case_id, cases!inner(summary_status)')
          .eq('mtb_id', mtb.id)
          .eq('cases.summary_status', 'verified');
        return {
          id: mtb.id,
          name: mtb.name,
          experts: (memberCount || 0) + 1,
          cases: (mtbCases || []).map(c => c.case_id),
          ownerId: mtb.owner_id,
          joinCode: mtb.join_code,
          notificationEnabled: mtb.notification_enabled ?? true,
        };
      }));

      setMTBs(mtbsWithCounts);
    } catch (err) {
      console.error('Failed to fetch MTBs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      refetchCases();
      refetchMTBs();
    }
  }, [user]);

  const createCase = async (
    caseData: Omit<Case, 'id' | 'createdDate' | 'ownerId'> & { requestId?: string },
    documents: Document[],
    questions: string[],
    shareWithMtbIds: string[] = [],
  ): Promise<{ caseId: string; createdAt: string }> => {
    if (!user) throw new Error('User not authenticated');
    const { data, error } = await supabase
      .from('cases')
      .insert({
        owner_id: user.id,
        case_name: caseData.caseName,
        patient_name: caseData.patientName,
        patient_age: caseData.age,
        patient_sex: caseData.sex,
        cancer_type: caseData.cancerType,
        summary: caseData.summary ?? null,
        summary_status: 'processing',
        request_id: caseData.requestId ?? null,
      })
      .select()
      .single();
    if (error) throw error;

    const caseId = data.id;

    // Insert documents
    if (documents.length > 0) {
      const docsToInsert = documents.map(doc => ({
        case_id: caseId,
        type: doc.type,
        file_name: doc.name,
        size: doc.size,
        storage_path: doc.storagePath || '',
      }));
      const { error: docsError } = await supabase.from('case_documents').insert(docsToInsert);
      if (docsError) throw docsError;
    }

    // Insert questions
    if (questions.length > 0) {
      const questionsToInsert = questions.map(q => ({ case_id: caseId, question_text: q }));
      const { error: qError } = await supabase.from('case_questions').insert(questionsToInsert);
      if (qError) throw qError;
    }

    // Share with selected MTBs in one batch
    if (shareWithMtbIds.length > 0) {
      const shareRows = shareWithMtbIds.map(mtbId => ({ case_id: caseId, mtb_id: mtbId }));
      const { error: shareError } = await supabase.from('mtb_cases').insert(shareRows);
      if (shareError) throw shareError;
    }

    await refetchCases();
    if (shareWithMtbIds.length > 0) {
      await refetchMTBs();
    }

    return { caseId, createdAt: data.created_at };
  };

  const updateCase = async (id: string, updates: Partial<Case>) => {
    if (!user) throw new Error('User not authenticated');
    const dbUpdates: any = {};
    if (updates.caseName !== undefined) dbUpdates.case_name = updates.caseName;
    if (updates.patientName !== undefined) dbUpdates.patient_name = updates.patientName;
    if (updates.age !== undefined) dbUpdates.patient_age = updates.age;
    if (updates.sex !== undefined) dbUpdates.patient_sex = updates.sex;
    if (updates.cancerType !== undefined) dbUpdates.cancer_type = updates.cancerType;
    if (updates.summary !== undefined) dbUpdates.summary = updates.summary;
    if (updates.treatmentPlan !== undefined) dbUpdates.treatment_plan = updates.treatmentPlan;

    const query = supabase.from('cases').update(dbUpdates).eq('id', id);
    if (user) {
      query.eq('owner_id', user.id);
    }

    const { error } = await query;
    if (error) throw error;
    await refetchCases();
  };

  const deleteCase = async (id: string) => {
    if (!user) throw new Error('User not authenticated');
    
    // Verify ownership
    const { data: caseData, error: fetchError } = await supabase
      .from('cases')
      .select('owner_id')
      .eq('id', id)
      .single();
    
    if (fetchError || !caseData) throw new Error('Case not found');
    if (caseData.owner_id !== user.id) throw new Error('Only the owner can delete this case');

    // Delete related data in correct order (respecting foreign keys)
    // 1. Delete opinions
    await supabase.from('case_opinions').delete().eq('case_id', id);
    // 2. Delete questions
    await supabase.from('case_questions').delete().eq('case_id', id);
    // 3. Delete documents metadata
    await supabase.from('case_documents').delete().eq('case_id', id);
    // 4. Remove from all MTBs
    await supabase.from('mtb_cases').delete().eq('case_id', id);
    // 5. Delete the case itself
    const { error } = await supabase.from('cases').delete().eq('id', id).eq('owner_id', user.id);
    if (error) throw error;
    
    await refetchCases();
    await refetchMTBs();
  };

  const verifySummary = async (caseId: string) => {
    if (!user) throw new Error('User not authenticated');
    
    // Verify ownership
    const { data: caseData, error: fetchError } = await supabase
      .from('cases')
      .select('owner_id')
      .eq('id', caseId)
      .single();
    
    if (fetchError || !caseData) throw new Error('Case not found');
    if (caseData.owner_id !== user.id) throw new Error('Only the owner can verify this case');

    // Update summary status to verified
    const { error } = await supabase
      .from('cases')
      .update({ summary_status: 'verified' })
      .eq('id', caseId);
    
    if (error) throw error;
    await refetchCases();
  };

  const verifyReport = async (caseId: string) => {
    if (!user) throw new Error('User not authenticated');
    
    // Verify ownership
    const { data: caseData, error: fetchError } = await supabase
      .from('cases')
      .select('owner_id')
      .eq('id', caseId)
      .single();
    
    if (fetchError || !caseData) throw new Error('Case not found');
    if (caseData.owner_id !== user.id) throw new Error('Only the owner can verify this case');

    // Update report status to verified
    const { error } = await supabase
      .from('cases')
      .update({ report_status: 'verified' })
      .eq('id', caseId);
    
    if (error) throw error;
    
    // Update local state immediately without full refetch
    setCases(prev => prev.map(c => 
      c.id === caseId ? { ...c, reportStatus: 'verified' } : c
    ));
  };

  const createMTB = async (name: string) => {
    if (!user) throw new Error('User not authenticated');
    const joinCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    const { error } = await supabase.from('mtbs').insert({
      owner_id: user.id,
      name,
      join_code: joinCode,
    });
    if (error) {
      // Check if it's a unique constraint violation for the name
      if (error.code === '23505' && error.message.includes('name')) {
        throw new Error('This MTB name is already taken. Please choose a different name.');
      }
      throw error;
    }
    await refetchMTBs();
  };

  const joinMTB = async (joinCode: string) => {
    if (!user) throw new Error('User not authenticated');
    const { data: mtb, error: mtbError } = await supabase
      .from('mtbs')
      .select('id, owner_id')
      .eq('join_code', joinCode)
      .maybeSingle();
    if (mtbError) throw mtbError;
    if (!mtb) throw new Error('Invalid join code');
    
    // Prevent owner from joining their own MTB
    if (mtb.owner_id === user.id) {
      throw new Error('You cannot join your own MTB');
    }

    const { error } = await supabase.from('mtb_members').insert({ mtb_id: mtb.id, user_id: user.id });
    if (error) throw error;
    await refetchMTBs();
  };

  const leaveMTB = async (mtbId: string) => {
    if (!user) throw new Error('User not authenticated');
    
    // Remove user from mtb_members
    const { error } = await supabase
      .from('mtb_members')
      .delete()
      .eq('mtb_id', mtbId)
      .eq('user_id', user.id);
    
    if (error) throw error;
    await refetchMTBs();
  };

  const addCaseToMTB = async (mtbId: string, caseId: string) => {
    const { error } = await supabase.from('mtb_cases').insert({ mtb_id: mtbId, case_id: caseId });
    if (error) throw error;
    await refetchMTBs();
  };

  const removeCaseFromMTB = async (mtbId: string, caseId: string) => {
    const { error } = await supabase
      .from('mtb_cases')
      .delete()
      .eq('mtb_id', mtbId)
      .eq('case_id', caseId);
    if (error) throw error;
    await refetchMTBs();
  };

  const updateMTBName = async (mtbId: string, newName: string) => {
    if (!user) throw new Error('User not authenticated');
    const { error } = await supabase
      .from('mtbs')
      .update({ name: newName })
      .eq('id', mtbId)
      .eq('owner_id', user.id);
    if (error) throw error;
    await refetchMTBs();
  };

  const updateMTBNotification = async (mtbId: string, enabled: boolean) => {
    if (!user) throw new Error('User not authenticated');
    const { error } = await supabase
      .from('mtbs')
      .update({ notification_enabled: enabled })
      .eq('id', mtbId);
    if (error) throw error;
    // Update local state immediately for responsive UI
    setMTBs(prev => prev.map(m => 
      m.id === mtbId ? { ...m, notificationEnabled: enabled } : m
    ));
  };

  const addOpinion = async (
    caseId: string,
    content: string,
    questionId: string | null = null,
    parentId: string | null = null,
    mtbId: string | null = null
  ) => {
    if (!user) throw new Error('User not authenticated');

    let opinionMtbId = mtbId ?? null;
    if (parentId) {
      const { data: parentOpinion, error: parentError } = await supabase
        .from('case_opinions')
        .select('mtb_id')
        .eq('id', parentId)
        .eq('case_id', caseId)
        .maybeSingle();

      if (parentError) throw parentError;
      if (!parentOpinion) throw new Error('Parent opinion not found');
      if (!parentOpinion.mtb_id) {
        throw new Error('Replies to legacy opinions without MTB context are not allowed');
      }
      opinionMtbId = parentOpinion.mtb_id;
    }

    if (!opinionMtbId) {
      throw new Error('MTB context is required to post opinions');
    }

    const { error } = await supabase.from('case_opinions').insert({
      case_id: caseId,
      user_id: user.id,
      opinion_text: content,
      question_id: questionId,
      parent_id: parentId,
      mtb_id: opinionMtbId,
    });
    if (error) throw error;
  };

  const updateOpinion = async (opinionId: string, content: string) => {
    const { error } = await supabase
      .from('case_opinions')
      .update({ opinion_text: content })
      .eq('id', opinionId);
    if (error) throw error;
  };

  const addFollowUp = async (caseId: string, followUp: string) => {
    if (!user) throw new Error('User not authenticated');
    const { error } = await supabase.from('case_follow_ups').insert({
      case_id: caseId,
      follow_up: followUp,
      created_by: user.id,
    });
    if (error) throw error;
  };

  const getCaseById = async (id: string, options: GetCaseByIdOptions = {}): Promise<Case | null> => {
    const { data: caseRow, error: caseError } = await supabase
      .from('cases')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (caseError || !caseRow) return null;

    const { data: docs } = await supabase.from('case_documents').select('*').eq('case_id', id);
    const { data: questions } = await supabase.from('case_questions').select('*').eq('case_id', id);
    let opinions: any[] = [];
    if (options.mtbId) {
      const { data: mtbOpinions } = await supabase
        .from('case_opinions')
        .select('*')
        .eq('case_id', id)
        .eq('mtb_id', options.mtbId)
        .order('created_at', { ascending: true });

      opinions = mtbOpinions || [];

      if (opinions.length === 0 && options.includeLegacyWhenNoMtbSpecific) {
        const { data: legacyOpinions } = await supabase
          .from('case_opinions')
          .select('*')
          .eq('case_id', id)
          .is('mtb_id', null)
          .order('created_at', { ascending: true });
        opinions = legacyOpinions || [];
      }
    } else {
      const { data: allOpinions } = await supabase
        .from('case_opinions')
        .select('*')
        .eq('case_id', id)
        .order('created_at', { ascending: true });
      opinions = allOpinions || [];
    }
    const { data: followUps } = await supabase.from('case_follow_ups').select('*').eq('case_id', id).order('created_at', { ascending: false });
    return {
      id: caseRow.id,
      caseName: caseRow.case_name,
      patientName: caseRow.patient_name,
      age: caseRow.patient_age,
      sex: caseRow.patient_sex,
      cancerType: caseRow.cancer_type,
      createdDate: caseRow.created_at.split('T')[0],
      summary: caseRow.summary,
      summaryStatus: caseRow.summary_status || 'processing',
      reportStatus: caseRow.report_status || 'not_ready',
      requestId: caseRow.request_id || null,
      ownerId: caseRow.owner_id,
      documents: (docs || []).map(d => ({
        id: d.id,
        name: d.file_name,
        size: d.size,
        type: d.type,
        storagePath: d.storage_path,
        mimeType: d.mime_type,
      })),
      questions: (questions || []).map(q => ({
        id: q.id,
        text: q.question_text,
      })),
      opinions: (opinions || []).map(o => ({
        id: o.id,
        caseId: o.case_id,
        questionId: o.question_id || null,
        parentId: o.parent_id || null,
        mtbId: o.mtb_id || null,
        authorUserId: o.user_id,
        content: o.opinion_text,
        createdAt: o.created_at,
      })),
      followUps: (followUps || []).map(f => ({
        id: f.id,
        caseId: f.case_id,
        followUp: f.follow_up,
        createdAt: f.created_at,
        createdBy: f.created_by,
      })),
      treatmentPlan: caseRow.treatment_plan,
    };
  };

  return (
    <CasesContext.Provider
      value={{
        cases,
        mtbs,
        loading,
        refetchCases,
        refetchMTBs,
        createCase,
        updateCase,
        deleteCase,
        verifySummary,
        verifyReport,
        createMTB,
        joinMTB,
        leaveMTB,
        addCaseToMTB,
        removeCaseFromMTB,
        updateMTBName,
        updateMTBNotification,
        addOpinion,
        updateOpinion,
        addFollowUp,
        getCaseById,
        refreshProcessingCases,
      }}
    >
      {children}
    </CasesContext.Provider>
  );
}

export function useCases() {
  const context = useContext(CasesContext);
  if (context === undefined) {
    throw new Error('useCases must be used within a CasesProvider');
  }
  return context;
}
