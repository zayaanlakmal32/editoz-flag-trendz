# Editoz Flag Trends — Setup (fresh build)

## 1. Rotate the Notion token (do this first)
The old token was pasted in plaintext in a previous chat. Before anything else:
1. Go to https://www.notion.so/my-integrations
2. Find the old integration, revoke/delete its old secret (or delete the integration entirely and create a new one).
3. Create a new internal integration, copy the new secret (starts with `ntn_` or `secret_`).
4. Open the **Weekly Audit Records** database in Notion → `...` menu → **Connections** → add your integration. (Without this step you'll get a 404, not a 401.)

## 2. Create the GitHub repo
1. Create a new repo (e.g. `editoz-flag-trendz`).
2. Add these 4 files to the repo root, preserving the folder structure:
   - `index.html`
   - `package.json`
   - `vercel.json`
   - `api/audit.js`
3. Commit and push to `main`.

## 3. Create the Vercel project
1. Import the GitHub repo into Vercel.
2. Before the first deploy, go to **Settings → Environment Variables** and add:
   - Key: `NOTION_TOKEN`
   - Value: your new integration secret from step 1
   - Environments: Production + Preview
3. Deploy.

## 4. Verify
Visit `https://<your-deployment>.vercel.app/api/audit` directly first.
- Valid JSON with `weeks`, `executionFlags`, `creativeFlags` → good, load the homepage next.
- `{"error":"Notion API request failed","status":401,...}` → token is wrong/not saved — re-check the env var value has no extra spaces/quotes, then redeploy (env var changes require a new deployment to take effect).
- `{"error":"Notion API request failed","status":404,...}` → integration isn't connected to the database (step 1.4).

## 5. Embed in Notion
In the Weekly Dashboard page, type `/embed` and paste your Vercel deployment URL.

---

**Note on updates:** if you edit `api/audit.js` later and Vercel seems to keep serving old code, force a redeploy from the Vercel dashboard (Deployments → ... → Redeploy) rather than assuming a git push alone refreshed it — that mismatch was the root cause last time.
