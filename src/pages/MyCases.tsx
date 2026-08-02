import { useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { Plus, AlertCircle, Search } from 'lucide-react';
import { Layout } from '../components/Layout';

import { StatusInfoIcon } from '../components/StatusInfoIcon';
import { useCases, SummaryStatus } from '../context/CasesContext';
import { supabase } from '../Supabase/client';
import { useIsMobile } from '../hooks/useMobile';

const getStatusBadge = (status?: SummaryStatus) => {
  switch (status) {
    case 'processing':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'In Progress' };
    case 'unverified':
      return { bg: 'bg-yellow-50', text: 'text-yellow-700', label: 'Pending' };
    case 'verified':
      return { bg: 'bg-green-50', text: 'text-green-700', label: 'Complete' };
    case 'failed':
      return { bg: 'bg-red-50', text: 'text-red-700', label: 'Failed' };
    default:
      return { bg: 'bg-yellow-50', text: 'text-yellow-700', label: 'Pending' };
  }
};

export function MyCases() {
  const navigate = useNavigate();
  const { cases, loading, refreshProcessingCases } = useCases();
  const [opinionCounts, setOpinionCounts] = useState<Record<string, number>>({});
  const [countsLoading, setCountsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const isMobile = useIsMobile();

  // Drag-to-scroll state
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  // Poll processing cases every 10s and stop when none left
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    const processingExists = cases.some(c => c.summaryStatus === 'processing');
    if (processingExists) {
      interval = setInterval(() => {
        void refreshProcessingCases();
      }, 10000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [cases, refreshProcessingCases]);

  // Fetch opinions count for listed cases
  useEffect(() => {
    const fetchOpinionCounts = async () => {
      if (!cases || cases.length === 0) {
        setOpinionCounts({});
        return;
      }
      try {
        setCountsLoading(true);
        const caseIds = cases.map(c => c.id);
        const { data } = await supabase
          .from('case_opinions')
          .select('case_id, user_id')
          .in('case_id', caseIds);
        const counts: Record<string, number> = {};
        const usersPerCase: Record<string, Set<string>> = {};
        (data || []).forEach((row: any) => {
          const cid = row.case_id as string;
          const uid = row.user_id as string;
          if (!usersPerCase[cid]) usersPerCase[cid] = new Set<string>();
          usersPerCase[cid].add(uid);
        });
        Object.keys(usersPerCase).forEach(cid => {
          counts[cid] = usersPerCase[cid].size;
        });
        setOpinionCounts(counts);
      } catch (err) {
        console.error('Failed to fetch opinion counts', err);
      } finally {
        setCountsLoading(false);
      }
    };
    fetchOpinionCounts();
  }, [cases]);

  // Drag-to-scroll handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!tableContainerRef.current) return;
    // Only start drag if clicking on the table container itself or td elements
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('button') || target.closest('a')) {
      return;
    }
    setIsDragging(true);
    setStartX(e.pageX - tableContainerRef.current.offsetLeft);
    setScrollLeft(tableContainerRef.current.scrollLeft);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !tableContainerRef.current) return;
    e.preventDefault();
    const x = e.pageX - tableContainerRef.current.offsetLeft;
    const walk = (x - startX) * 1.5; // Scroll speed multiplier
    tableContainerRef.current.scrollLeft = scrollLeft - walk;
  };

  const handleMouseUpOrLeave = () => {
    setIsDragging(false);
  };

  // Filter and sort cases
  const filteredAndSortedCases = cases
    .filter(caseItem => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      return (
        caseItem.caseName.toLowerCase().includes(query) ||
        caseItem.patientName?.toLowerCase().includes(query) ||
        caseItem.cancerType.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'oldest':
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case 'name':
          return a.caseName.localeCompare(b.caseName);
        default:
          return 0;
      }
    });

  return (
    <Layout wide>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        {/* Header */}
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">My Cases</h1>
          <button
            onClick={() => navigate('/cases/new/step-1')}
            className="flex items-center justify-center space-x-2 text-white rounded-lg transition px-4 py-2.5 font-medium"
            style={{ backgroundColor: '#4A90E2' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#357ABD')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#4A90E2')}
          >
            <Plus className="w-5 h-5" />
            <span>Add New Case</span>
          </button>
        </div>

        {/* Info Banner */}
        <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#4A90E2' }} />
          <p className="text-sm" style={{ color: '#4A5565' }}>
            Only verified cases are shared into MTBs. Make sure all case information is accurate before requesting verification.
          </p>
        </div>

        {/* Search and Sort */}
        {!isMobile && (
          <div className="flex gap-4 items-center">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                placeholder="Search by case name, patient name, or cancer type..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
              />
            </div>
            <div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 transition text-sm"
                style={{ '--tw-ring-color': '#4A90E2' } as React.CSSProperties}
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
                <option value="name">Name (A-Z)</option>
              </select>
            </div>
          </div>
        )}

        {/* Mobile Card View */}
        {isMobile ? (
          <div className="space-y-3">
            {loading ? (
              <div className="text-center py-8 text-gray-500">Loading cases...</div>
            ) : filteredAndSortedCases.length === 0 ? (
              <div className="text-center py-8 text-gray-500 bg-white rounded-lg shadow">
                {searchQuery ? 'No cases found matching your search.' : 'No cases yet. Create your first case!'}
              </div>
            ) : (
              filteredAndSortedCases.map((caseItem) => (
                <div
                  key={caseItem.id}
                  className="bg-white rounded-lg shadow p-4 cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => navigate(`/case/${caseItem.id}`)}
                >
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-medium text-gray-900 text-sm line-clamp-1 flex-1 mr-2">
                      {caseItem.caseName}
                    </h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${
                      getStatusBadge(caseItem.summaryStatus).bg
                    } ${getStatusBadge(caseItem.summaryStatus).text}`}>
                      {getStatusBadge(caseItem.summaryStatus).label}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 mb-3">
                    <div>
                      <span className="text-gray-400">Patient: </span>
                      <span className="font-medium text-gray-700">{caseItem.patientName || 'Anonymous'}</span>
                    </div>
                    <div>
                      <span className="text-gray-400">Info: </span>
                      <span className="font-medium text-gray-700">{caseItem.age}Y, {caseItem.sex}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-gray-400">Cancer: </span>
                      <span className="font-medium text-gray-700 line-clamp-1">{caseItem.cancerType}</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span>Opinions: {countsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}</span>
                      <span>{caseItem.createdDate}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          /* Desktop Table View */
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div 
              ref={tableContainerRef}
              className="overflow-x-auto no-scrollbar select-none"
              style={{ cursor: isDragging ? 'grabbing' : 'grab', overflowY: 'visible' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUpOrLeave}
              onMouseLeave={handleMouseUpOrLeave}
            >
              <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5565' }}>
                    Case Name
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5565' }}>
                    Patient Name
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5565' }}>
                    Patient Info
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5565' }}>
                    Cancer Type
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5565' }}>
                    <div className="flex items-center gap-2 relative">
                      Summary Status
                      <StatusInfoIcon />
                    </div>
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5565' }}>
                    Opinions
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5565' }}>
                    Created Date
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-500">Loading cases...</td></tr>
              ) : filteredAndSortedCases.length === 0 ? (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                  {searchQuery ? 'No cases found matching your search.' : 'No cases yet. Create your first case!'}
                </td></tr>
              ) : filteredAndSortedCases.map((caseItem) => (
                <tr 
                  key={caseItem.id} 
                  onClick={() => navigate(`/case/${caseItem.id}`)}
                  className="hover:bg-blue-50 transition-colors cursor-pointer"
                >
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">
                    <div className="max-w-[200px] truncate">{caseItem.caseName}</div>
                  </td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#4A5565' }}>
                    <div className="max-w-[150px] truncate">{caseItem.patientName || 'Anonymous'}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: '#4A5565' }}>
                    {caseItem.age}Y, {caseItem.sex}
                  </td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#4A5565' }}>
                    <div className="max-w-[180px] truncate">{caseItem.cancerType}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      getStatusBadge(caseItem.summaryStatus).bg
                    } ${getStatusBadge(caseItem.summaryStatus).text}`}>
                      {getStatusBadge(caseItem.summaryStatus).label}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: '#4A5565' }}>
                    {countsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm" style={{ color: '#4A5565' }}>
                    {caseItem.createdDate}
                  </td>
                </tr>
              ))}
              </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
