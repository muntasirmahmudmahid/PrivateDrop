# PrivateDrop — deployment guide

This is a small private file-transfer website: one `index.html` frontend plus Supabase Auth, a private Storage bucket, and a Postgres table. Deploy the frontend to GitHub + Vercel. Your PC does not need to stay on.

## Important security facts

- Do **not** add a Supabase `service_role` key to `index.html`, GitHub, or Vercel frontend variables. The frontend uses only the public anon/publishable key; database/storage policies protect the data.
- This version uses ID + password by mapping an ID to a synthetic Supabase Auth email: `yourid@privatedrop.invalid`. Users must be created by the owner in Supabase Auth; there is no public registration form.
- Files are shared among every account you create for this workspace. Only create accounts for people you trust.
- A successful browser fetch triggers server object deletion. A browser cannot guarantee the file was saved permanently to disk; it confirms that the file was fetched to the browser before requesting deletion.
- The download claim avoids two ordinary simultaneous clicks, but this is not a high-assurance transactional download service. Do not use it for highly sensitive or irreplaceable files without a backend endpoint that streams and consumes files atomically.
- Free-tier limits, inactivity pauses, upload sizes and bandwidth depend on your Supabase/Vercel plans. The UI currently limits each file to 50 MB.
- Account count is controlled manually in Supabase Auth; create no more than five accounts.

## 1. Create Supabase backend

1. Create a project at https://supabase.com/
2. Open **SQL Editor** and run all of `supabase/setup.sql`.
3. In **Authentication → Providers → Email**, keep Email provider enabled. Turn off public sign-ups if that setting is available for your project.
4. Under **Project Settings → API**, copy the Project URL and the anon/public key. Never copy the `service_role` key into the frontend.
5. In `index.html`, replace:
   - `PASTE_SUPABASE_URL_HERE`
   - `PASTE_SUPABASE_ANON_KEY_HERE`

## 2. Create account IDs

In **Authentication → Users → Add user / Create new user**, create each user with:
- Email: `yourchosenid@privatedrop.invalid` (example: `labpc@privatedrop.invalid`)
- A strong password you choose.

The part before `@privatedrop.invalid` is the ID entered on the website. Create at most five accounts. Do not reuse your email password.

If your Supabase project requires email confirmation, either configure confirmation for your setup or mark the manually created users as confirmed in the dashboard. Do not enable public registration just to make login work.

## 3. Deploy to GitHub and Vercel

1. Create a GitHub repository, for example `privatedrop`.
2. Upload `index.html`, `README.md`, and the `supabase` folder.
3. In Vercel, import the repository. It is a static site, so no build command is needed; set the output/root directory to the repository root.
4. Deploy, then open the Vercel URL over HTTPS and test with a non-sensitive small file.

## 4. Test before real use

- Sign in with a test account from one browser/device.
- Upload a small test file.
- Open the site on a second device/browser and sign in with any created account.
- Download the test file and confirm it disappears from the shared inbox and Storage.
- Test a failed/interrupted download and verify the file can be retried.
- Review Supabase Storage and database logs.

## Known design limitations

- The SQL `download_claimed_at` prevents ordinary concurrent claims, but claims do not expire automatically in the current listing query; if a browser closes after claiming a file, an owner may need to clear that row's `download_claimed_at` in the SQL editor to make it available again. For a robust production system, implement an Edge Function that issues a short-lived download ticket, streams the file, and deletes only after server-side completion.
- The app is a shared inbox: any signed-in account can view, download and delete shared files. Do not give credentials to untrusted users.
- No website can guarantee secure erasure from backups, caches, or a recipient's device. “Delete” means removing the live Storage object and its database row.
