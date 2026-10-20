# Kuuz_Portfolio

An editorial-style, responsive portfolio for Kuuz. It lives in the `portfolio/` folder so it can be deployed separately from the existing KUUZ.WORKSPACE app.

## Image publishing

The upload page at `/upload.html` supports permanent image uploads to Vercel Blob. Uploaded images are public and the newest image for each project automatically replaces that project's visual on the portfolio homepage.

### Required Vercel setup

1. Create a **separate Vercel project** from this repository. Do not change the existing KUUZ.WORKSPACE / `work-tracker` project.
2. Set **Root Directory** to `portfolio`.
3. Set **Framework Preset** to Other. Leave the Build Command blank and set Output Directory to `.`.
4. In the new portfolio project, open **Storage** and create/connect a **Blob** store. This provides the `BLOB_READ_WRITE_TOKEN` environment variable. Redeploy after connecting it.
5. In **Settings → Environment Variables**, add `PORTFOLIO_UPLOAD_PASSWORD` with a strong private password. Apply it to Production (and Preview only if desired), then redeploy.
6. Open the deployed `/upload.html` page, enter that password, choose the project to update, select images and click **Upload & publish**.

The upload API validates the password server-side. Do not put the password in HTML or share it with visitors. Only upload images you have permission to publish. Images uploaded to Blob are public.

### Project mapping

- `viso-pises` — Viso Pises — Growing Up Together
- `walls-ice-cream` — Wall’s — Ice Cream
- `isuzu` — Isuzu — Digital & Video Content
- `breeze` — Breeze — KOL Campaigns
- `cement-brands` — Cement Brands — Digital Content
- `campaign-development` — Campaign Development & Production

## Before publishing

- Replace `hello@example.com` with your professional email.
- Verify each project summary and your exact role/contribution.
- Remove confidential client information and use only approved work samples.
- Test the mobile layout, project filters and upload workflow.

## Case-study template

- Context / brief
- Objective
- Audience insight
- My role and responsibilities
- Creative or strategic approach
- Deliverables
- Outcome (only use verified, approved metrics)
