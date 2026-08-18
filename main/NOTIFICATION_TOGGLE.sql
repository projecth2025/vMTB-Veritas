-- ============================================
-- SQL Migration: Add Meeting Notification Toggle
-- ============================================
-- This script adds the notification_enabled column to the MTBs table
-- to control whether WhatsApp notifications are sent when meetings start.
-- ============================================

-- Step 1: Add the notification_enabled column to mtbs table
-- Default is TRUE so notifications are sent unless explicitly turned off
ALTER TABLE mtbs
ADD COLUMN IF NOT EXISTS notification_enabled BOOLEAN DEFAULT TRUE NOT NULL;

-- Step 2: Add a comment to the column for documentation
COMMENT ON COLUMN mtbs.notification_enabled IS 'Controls whether WhatsApp notifications are sent to members when a meeting is started. Default is TRUE.';

-- Step 3: Create an index for faster lookups (optional but recommended)
CREATE INDEX IF NOT EXISTS idx_mtbs_notification_enabled ON mtbs(notification_enabled);

-- ============================================
-- RLS Policy Updates (if needed)
-- ============================================
-- The notification_enabled column should follow the same RLS policies
-- as other columns in the mtbs table. No additional policies needed
-- since SELECT/UPDATE on mtbs should already be configured.

-- ============================================
-- Verification Query
-- ============================================
-- Run this to verify the column was added successfully:
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'mtbs' AND column_name = 'notification_enabled';

-- ============================================
-- Example Edge Function Check (for reference)
-- ============================================
-- In your Supabase Edge Function that handles meeting start notifications,
-- you should check this value before sending WhatsApp notifications:
--
-- const { data: mtb } = await supabase
--   .from('mtbs')
--   .select('notification_enabled')
--   .eq('id', mtbId)
--   .single();
--
-- if (mtb?.notification_enabled) {
--   // Send WhatsApp notifications to members
-- }
