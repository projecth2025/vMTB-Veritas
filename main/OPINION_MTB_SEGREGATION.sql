-- MTB-wise opinion segregation migration
-- 1) Add nullable mtb_id column for backward compatibility
ALTER TABLE case_opinions
ADD COLUMN IF NOT EXISTS mtb_id uuid;

-- 2) Add foreign key to mtbs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_case_opinions_mtb'
  ) THEN
    ALTER TABLE case_opinions
    ADD CONSTRAINT fk_case_opinions_mtb
    FOREIGN KEY (mtb_id)
    REFERENCES mtbs(id)
    ON DELETE CASCADE;
  END IF;
END $$;

-- 3) Add composite index for case + mtb fetches
CREATE INDEX IF NOT EXISTS idx_case_opinions_case_mtb
ON case_opinions(case_id, mtb_id);
