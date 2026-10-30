# KUUZ OS — Foundation

KUUZ OS is a separate personal operating system being developed alongside the existing KUUZ WORKSPACE application.

## First version
- Command center with daily priorities and attention prompts
- Decision database
- Opportunity radar
- Weekly review
- JSON backup export
- Responsive layout for desktop and mobile

## Current storage limitation
Version 0.1 stores data in the current browser using localStorage. Data does not sync between devices or browsers, and clearing browser storage can remove it. Use **Export backup** regularly. Do not enter highly sensitive financial, client, or personal information.

## Architecture direction
- Frontend: keep the first module lightweight and mobile responsive; evaluate migration to a maintainable component architecture after validating workflows.
- Authentication: Supabase Auth, reusing the existing project's auth model only after explicit schema/config review.
- Database: separate KUUZ OS tables and user-scoped row-level security; do not alter existing `tasks` or `kol_videos` tables.
- Hosting: use an isolated preview deployment first. Do not change production routing or overwrite the existing workspace.
- Integrations: add calendar, email, finance, and automation connections only with explicit user authorization.

## Planned modules
1. Command center
2. Decision intelligence
3. Opportunity radar
4. Knowledge capital
5. Automation desk
6. Personal finance
7. Future Kuuz / independent ventures

## Safety
All changes are developed on `feat/kuuz-os-foundation`. Production and live data remain unchanged until reviewed and approved.
