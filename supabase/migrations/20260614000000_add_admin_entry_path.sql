ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS admin_entry_path text NOT NULL DEFAULT '/admin';

UPDATE public.site_settings
SET admin_entry_path = '/admin'
WHERE admin_entry_path IS NULL OR btrim(admin_entry_path) = '';

DO $$
BEGIN
  IF to_regclass('dev.site_settings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE dev.site_settings ADD COLUMN IF NOT EXISTS admin_entry_path text NOT NULL DEFAULT ''/admin''';
    EXECUTE 'UPDATE dev.site_settings SET admin_entry_path = ''/admin'' WHERE admin_entry_path IS NULL OR btrim(admin_entry_path) = ''''';
  END IF;
END $$;
