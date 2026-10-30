# KUUZ OS — Foundation

KUUZ OS is a separate personal operating system being developed alongside the existing KUUZ WORKSPACE application.

## First version
- Command center with daily priorities and attention prompts
- Decision database
- Opportunity radar
- Weekly review
- JSON backup export
- Responsive layout for desktop and mobile
- Optional Supabase email/password authentication and cross-device data sync

## Hosting and isolation
- Target hosting: Netlify Free, using the repository's existing `netlify.toml` configuration. Its current Free plan has a hard monthly credit cap; sites pause at the limit and the Free plan does not automatically recharge.
- The existing Vercel deployment is retained only as an isolated development preview while Netlify is connected. Vercel Hobby is restricted to non-commercial personal use, so do not assume it is the long-term free host for a work-related product.
- No Cloudflare migration is required.
- Netlify site creation / GitHub connection still requires the account owner to authorize it. Do not enable a paid plan or auto-recharge.

## Cloud sync setup
1. Create a separate Supabase project for KUUZ OS.
2. In that new project's SQL Editor, run `work-tracker/kuuz-os-supabase-setup.sql`.
3. Copy the Supabase Project URL and publishable/anon key into KUUZ OS > Cloud sync.
4. Create an account or sign in using the same email on each device.
5. Use the same account on laptop and phone.

The app stores only the public project URL and publishable/anon key in that browser. Never enter a service_role key. The SQL creates one dedicated `kuuz_os_sync` table with row-level security so authenticated users can access only their own record. Do not run this SQL in the existing KUUZ WORKSPACE database.

## Sync behavior and limitations
- Local browser storage remains the immediate working copy and JSON export remains available.
- Changes are queued for cloud upload shortly after saving; the app checks cloud data when the page becomes visible and when the user chooses Sync now.
- First sign-in merges local records with existing cloud records. Deleted task/decision/opportunity IDs are retained as tombstones to avoid resurrecting those items during normal merges.
- This is a lightweight single-user sync foundation, not a real-time collaborative editor. Avoid editing the same record simultaneously on multiple devices; use Sync now after switching devices.
- Supabase free-tier quotas, project pausing and email delivery settings are controlled by Supabase and may change. No paid upgrade should be enabled without explicit approval.

## Data and security
- Database: one separate KUUZ OS table, user-scoped row-level security; do not alter existing `tasks` or `kol_videos` tables.
- Authentication: Supabase Auth in the separate project.
- No service-role key or private database credential is used in the browser.
- Integrations such as calendar, email, finance and AI remain optional and require explicit authorization.

## Planned modules
1. Command center
2. Decision intelligence
3. Opportunity radar
4. Knowledge capital
5. Automation desk
6. Personal finance
7. Future Kuuz / independent ventures

## Safety
All changes are developed on `feat/kuuz-os-foundation`. The work remains in draft PR #7 and must not be merged without review. Production and existing live data remain unchanged.
