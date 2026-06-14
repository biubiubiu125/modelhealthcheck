CREATE TABLE IF NOT EXISTS public.telegram_push_config (
  singleton_key text PRIMARY KEY CHECK (singleton_key = 'global'),
  project_name text NOT NULL DEFAULT 'RKAPI模型状态检测',
  bot_token text,
  chat_id text,
  auto_push_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.telegram_push_records (
  id uuid PRIMARY KEY,
  project_name text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  chat_id text,
  notification_key text,
  event_type text,
  status text NOT NULL DEFAULT 'pending',
  push_count integer NOT NULL DEFAULT 0,
  failure_reason text,
  last_pushed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.telegram_push_records
  ADD COLUMN IF NOT EXISTS notification_key text;

ALTER TABLE public.telegram_push_records
  ADD COLUMN IF NOT EXISTS event_type text;

CREATE INDEX IF NOT EXISTS idx_telegram_push_records_created_at
  ON public.telegram_push_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_push_records_status
  ON public.telegram_push_records (status);
CREATE INDEX IF NOT EXISTS idx_telegram_push_records_notification_key
  ON public.telegram_push_records (notification_key);

ALTER TABLE public.telegram_push_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_push_records ENABLE ROW LEVEL SECURITY;

INSERT INTO public.telegram_push_config (singleton_key, project_name, auto_push_enabled)
VALUES ('global', 'RKAPI模型状态检测', true)
ON CONFLICT (singleton_key) DO NOTHING;

DO $$
BEGIN
  IF to_regprocedure('public.update_updated_at_column()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS update_telegram_push_config_updated_at ON public.telegram_push_config;
    CREATE TRIGGER update_telegram_push_config_updated_at
      BEFORE UPDATE ON public.telegram_push_config
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

    DROP TRIGGER IF EXISTS update_telegram_push_records_updated_at ON public.telegram_push_records;
    CREATE TRIGGER update_telegram_push_records_updated_at
      BEFORE UPDATE ON public.telegram_push_records
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'dev') THEN
    EXECUTE '
      CREATE TABLE IF NOT EXISTS dev.telegram_push_config (
        singleton_key text PRIMARY KEY CHECK (singleton_key = ''global''),
        project_name text NOT NULL DEFAULT ''RKAPI模型状态检测'',
        bot_token text,
        chat_id text,
        auto_push_enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT timezone(''utc'', now()),
        updated_at timestamptz NOT NULL DEFAULT timezone(''utc'', now())
      )
    ';

    EXECUTE '
      CREATE TABLE IF NOT EXISTS dev.telegram_push_records (
        id uuid PRIMARY KEY,
        project_name text NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        chat_id text,
        notification_key text,
        event_type text,
        status text NOT NULL DEFAULT ''pending'',
        push_count integer NOT NULL DEFAULT 0,
        failure_reason text,
        last_pushed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT timezone(''utc'', now()),
        updated_at timestamptz NOT NULL DEFAULT timezone(''utc'', now())
      )
    ';

    EXECUTE 'ALTER TABLE dev.telegram_push_records ADD COLUMN IF NOT EXISTS notification_key text';
    EXECUTE 'ALTER TABLE dev.telegram_push_records ADD COLUMN IF NOT EXISTS event_type text';

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_telegram_push_records_created_at ON dev.telegram_push_records (created_at DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_telegram_push_records_status ON dev.telegram_push_records (status)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_telegram_push_records_notification_key ON dev.telegram_push_records (notification_key)';
    EXECUTE 'ALTER TABLE dev.telegram_push_config ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE dev.telegram_push_records ENABLE ROW LEVEL SECURITY';

    EXECUTE '
      INSERT INTO dev.telegram_push_config (singleton_key, project_name, auto_push_enabled)
      VALUES (''global'', ''RKAPI模型状态检测'', true)
      ON CONFLICT (singleton_key) DO NOTHING
    ';

    IF to_regprocedure('public.update_updated_at_column()') IS NOT NULL THEN
      EXECUTE 'DROP TRIGGER IF EXISTS update_telegram_push_config_updated_at ON dev.telegram_push_config';
      EXECUTE 'CREATE TRIGGER update_telegram_push_config_updated_at BEFORE UPDATE ON dev.telegram_push_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
      EXECUTE 'DROP TRIGGER IF EXISTS update_telegram_push_records_updated_at ON dev.telegram_push_records';
      EXECUTE 'CREATE TRIGGER update_telegram_push_records_updated_at BEFORE UPDATE ON dev.telegram_push_records FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
    END IF;
  END IF;
END $$;
