-- ============================================================
-- FIX: 406 Error on case_additional_documents table
-- Issue: Row Level Security (RLS) enabled but no policies exist
-- ============================================================

-- OPTION 1: Add RLS Policies (RECOMMENDED for production)
-- This allows authenticated users to manage their own case documents

-- Enable RLS (if not already enabled)
ALTER TABLE case_additional_documents ENABLE ROW LEVEL SECURITY;

-- Policy 1: Allow users to SELECT their own case documents
CREATE POLICY "Users can view case additional documents for their cases"
ON case_additional_documents
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM cases
    WHERE cases.id = case_additional_documents.case_id
    AND cases.user_id = auth.uid()
  )
);

-- Policy 2: Allow users to INSERT additional documents for their cases
CREATE POLICY "Users can insert case additional documents for their cases"
ON case_additional_documents
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM cases
    WHERE cases.id = case_additional_documents.case_id
    AND cases.user_id = auth.uid()
  )
);

-- Policy 3: Allow users to UPDATE their own case documents
CREATE POLICY "Users can update case additional documents for their cases"
ON case_additional_documents
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM cases
    WHERE cases.id = case_additional_documents.case_id
    AND cases.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM cases
    WHERE cases.id = case_additional_documents.case_id
    AND cases.user_id = auth.uid()
  )
);

-- Policy 4: Allow users to DELETE their own case documents
CREATE POLICY "Users can delete case additional documents for their cases"
ON case_additional_documents
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM cases
    WHERE cases.id = case_additional_documents.case_id
    AND cases.user_id = auth.uid()
  )
);

-- ============================================================
-- OPTION 2: Disable RLS (ONLY for testing/development)
-- WARNING: This allows anyone to read/write ALL documents
-- DO NOT use in production!
-- ============================================================

-- Uncomment the line below ONLY if you want to disable RLS temporarily
-- ALTER TABLE case_additional_documents DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- Verify Policies
-- ============================================================

-- Run this to check if policies were created:
SELECT schemaname, tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE tablename = 'case_additional_documents';
