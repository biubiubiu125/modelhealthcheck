ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS telegram_notification_name text NOT NULL DEFAULT 'RKAPI模型监控';

CREATE TABLE IF NOT EXISTS public.telegram_alert_states (
  notification_key text PRIMARY KEY,
  config_id uuid NOT NULL,
  model text NOT NULL,
  state text NOT NULL DEFAULT 'healthy',
  failure_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  last_status text,
  last_message text,
  failure_started_at timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  last_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.telegram_alert_states ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name = 'update_updated_at_column'
  ) THEN
    DROP TRIGGER IF EXISTS update_telegram_alert_states_updated_at ON public.telegram_alert_states;
    CREATE TRIGGER update_telegram_alert_states_updated_at
      BEFORE UPDATE ON public.telegram_alert_states
      FOR EACH ROW
      EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('dev.site_settings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE dev.site_settings ADD COLUMN IF NOT EXISTS telegram_notification_name text NOT NULL DEFAULT ''RKAPI模型监控''';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'dev') THEN
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS dev.telegram_alert_states (
        notification_key text PRIMARY KEY,
        config_id uuid NOT NULL,
        model text NOT NULL,
        state text NOT NULL DEFAULT 'healthy',
        failure_count integer NOT NULL DEFAULT 0,
        success_count integer NOT NULL DEFAULT 0,
        last_status text,
        last_message text,
        failure_started_at timestamptz,
        last_failure_at timestamptz,
        last_success_at timestamptz,
        last_notified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
        updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
      );
    $sql$;

    EXECUTE 'ALTER TABLE dev.telegram_alert_states ENABLE ROW LEVEL SECURITY';

    IF EXISTS (
      SELECT 1
      FROM information_schema.routines
      WHERE routine_schema = 'public'
        AND routine_name = 'update_updated_at_column'
    ) THEN
      EXECUTE 'DROP TRIGGER IF EXISTS update_telegram_alert_states_updated_at ON dev.telegram_alert_states';
      EXECUTE 'CREATE TRIGGER update_telegram_alert_states_updated_at BEFORE UPDATE ON dev.telegram_alert_states FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
    END IF;
  END IF;
END $$;
