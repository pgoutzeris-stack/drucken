/**
 * ROOTS Drucken – public browser configuration.
 *
 * The anon key only identifies the Supabase project; access is decided by Auth,
 * RLS and the e-mail domain check below. Never place a service-role key here.
 */
window.ROOTS_PRINT_CONFIG = {
  SUPABASE_URL: "https://csmguwcvzreefluhahyu.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzbWd1d2N2enJlZWZsdWhhaHl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NjM0ODcsImV4cCI6MjA5MjUzOTQ4N30.Fiafx7XBaQZXUX3bKQIBH7znBHx3B51yL-bftOHsL4Q",
  ALLOWED_EMAIL_DOMAINS: ["roots-consultants.com", "roots-consultants.de"],
  BRIDGE_ORIGINS: ["http://127.0.0.1:7331", "http://localhost:7331"],
};
