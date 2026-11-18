-- Persisted pilot intake (P4).
--
-- The marketing site has no runtime of its own and must not show success until
-- a submission is stored. This table is deliberately cross-workspace and
-- internal: it has no workspace_id, no RLS policy, and is written by the public
-- `POST /api/pilot-leads` route through wukong_app. It is not part of any
-- tenant's operational data and must never be joined to catalog tables.
--
-- No product files, customer data or credentials are accepted here. The route
-- stores only the contact fields the marketing form collects, a consent
-- timestamp, and a salted hash of the request IP for rate limiting.

CREATE TABLE IF NOT EXISTS public.pilot_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL,
  platforms text[] NOT NULL DEFAULT '{}',
  sku_volume text,
  message text,
  locale text NOT NULL DEFAULT 'en',
  source text NOT NULL DEFAULT 'marketing',
  consent_at timestamptz NOT NULL,
  request_ip_hash text,
  user_agent text,
  CONSTRAINT pilot_leads_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT pilot_leads_email_check CHECK (
    char_length(email) BETWEEN 3 AND 254 AND email = lower(email)
  ),
  CONSTRAINT pilot_leads_company_check CHECK (char_length(company) BETWEEN 1 AND 160),
  CONSTRAINT pilot_leads_platforms_check CHECK (cardinality(platforms) <= 6),
  CONSTRAINT pilot_leads_sku_volume_check CHECK (
    sku_volume IS NULL OR sku_volume IN ('under_100', '100_500', '500_2000', 'over_2000')
  ),
  CONSTRAINT pilot_leads_message_check CHECK (message IS NULL OR char_length(message) <= 2000),
  CONSTRAINT pilot_leads_locale_check CHECK (locale IN ('en', 'zh-Hant')),
  CONSTRAINT pilot_leads_source_check CHECK (char_length(source) BETWEEN 1 AND 80),
  CONSTRAINT pilot_leads_ip_hash_check CHECK (
    request_ip_hash IS NULL OR request_ip_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT pilot_leads_user_agent_check CHECK (
    user_agent IS NULL OR char_length(user_agent) <= 500
  )
);

-- Recent-by-contact lookups for the route's rolling ten-minute limit.
CREATE INDEX IF NOT EXISTS pilot_leads_email_recent_idx
  ON public.pilot_leads(email, created_at DESC);
CREATE INDEX IF NOT EXISTS pilot_leads_ip_recent_idx
  ON public.pilot_leads(request_ip_hash, created_at DESC)
  WHERE request_ip_hash IS NOT NULL;

-- Public intake runs as the non-superuser application role, which has no
-- default table privileges. SELECT is required by the route's rolling-limit
-- count; INSERT is the only write. Operators inspect and delete through the
-- admin connection, never through the app role.
GRANT SELECT, INSERT ON TABLE public.pilot_leads TO wukong_app;
