# PrivateDrop — private file transfer

একটা ছোট private file-sharing website। Frontend: `index.html` + `script.js` + `style.css`। Backend: Supabase (Auth, Storage, Database)। Hosting: GitHub + Vercel। তোমার PC চালু রাখতে হবে না।

## কী কী আছে

- প্রতিটা user-এর আলাদা ID + password, আর প্রত্যেকে **শুধু নিজের ফাইল** দেখে (Supabase RLS policy)।
- ফাইল আর ফাইলের নাম **browser-এই encrypt** হয় (AES-256)। Key তৈরি হয় ID + password থেকে, Supabase-এ যায় না। তাই Supabase Dashboard খুললেও ফাইলের ভেতরের কিছু দেখা যায় না।
- Download all / Delete all বাটন।
- Registration শুধু **গোপন invite link** দিয়ে, সর্বোচ্চ ৫ জন (সংখ্যা বদলানো যায়)। সীমা পূর্ণ হলে link আর কাজ করে না।

## ⚠️ জেনে রাখো

- **Password ভুললে ফাইল চিরতরে হারাবে।** Admin reset করলেও পুরনো ফাইল খুলবে না (এটাই encryption-এর মূল্য)।
- Dashboard-এ owner দেখতে পায়: কে কখন ফাইল upload করেছে, ফাইলের আনুমানিক size, আর user সংখ্যা। ভেতরের কিছু না।
- Frontend code owner-ই deploy করে, তাই owner চাইলে কোড বদলে password ধরতে পারে। Encryption এটা আটকায় না। শুধু বিশ্বাসী লোকদের account দাও।
- Browser-এ key রাখা হয় যাতে reload করলে আবার login না লাগে। **Public/university PC-তে কাজ শেষে অবশ্যই Log out করো**, তাহলে key মুছে যায়।
- প্রতি ফাইল সর্বোচ্চ প্রায় ৫০ MB। Free plan-এর limit Supabase/Vercel অনুযায়ী বদলায়।
- `service_role` key কখনো GitHub/Vercel/script.js-এ দিও না। শুধু public anon key ব্যবহার হয়।

## ১. Supabase backend বানাও

1. https://supabase.com এ নতুন project খোলো।
2. `supabase/setup.sql` ফাইলটা খুলে এই লাইনে তোমার গোপন code বসাও:
   `values (true, 'CHANGE_THIS_TO_A_LONG_RANDOM_CODE', 5)`
   - Code বানাতে SQL Editor-এ `select gen_random_uuid();` run করো, যে লেখা আসবে সেটা ব্যবহার করো।
   - শেষের `5` হলো সর্বোচ্চ user সংখ্যা (তোমার নিজেরটাসহ)।
3. পুরো `setup.sql` SQL Editor-এ paste করে **Run** করো।
4. **Authentication → Providers → Email:**
   - Email provider **চালু** রাখো।
   - **"Confirm email" বন্ধ** করো। (আমরা নকল email ব্যবহার করি, confirm চালু থাকলে কেউ login করতে পারবে না।)
   - Sign-ups চালু থাকুক। Invite code ছাড়া কেউ account খুলতে পারবে না, database আটকে দেয়।
5. **Project Settings → API** থেকে Project URL আর anon/public key নাও। `script.js`-এর শুরুতে `SUPABASE_URL` ও `SUPABASE_ANON_KEY` বদলাও (নিজের project হলে)।

## ২. GitHub + Vercel-এ deploy

1. GitHub-এ repository খোলো, সব ফাইল upload করো (`index.html`, `script.js`, `style.css`, `favicon.png`, `README.md`, `supabase/`)।
2. Vercel-এ repository import করো। এটা static site, কোনো build command লাগবে না। Root directory = repository root।
3. Deploy হলে HTTPS link পাবে, যেমন `https://privatedrop.vercel.app`।

## ৩. Invite link বানাও আর account খোলো

Link-এর গঠন: `https://তোমার-site.vercel.app/?invite=তোমার-গোপন-code`

1. **আগে নিজে** এই link খুলে নিজের ID + password দিয়ে Register করো (তুমি প্রথম user)।
2. তারপর বিশ্বাসী লোকদের একই link পাঠাও (সরাসরি WhatsApp/message-এ, public-এ না)।
3. যখন সীমা পূর্ণ হবে (যেমন ৫ জন), link দিয়ে আর কেউ account খুলতে পারবে না।

## ৪. User delete করে নতুন নেওয়া

1. Supabase → **Authentication → Users** থেকে user delete করো। তার ফাইলের তালিকা নিজে থেকে মুছে যায়।
2. Storage-এ তার ফাইল থেকে যায়। জায়গা খালি করতে **Storage → `private-files`** এ গিয়ে তার user id নামের folder delete করো।
3. একটা জায়গা খালি হলো, নতুন কেউ link দিয়ে আসতে পারবে।
4. ⚠️ পুরনো user link জানে। বের করে দেওয়া হলে code বদলে নতুন link বানাও (নিচে দেখো)।

## ৫. Code বা সীমা বদলানো (SQL Editor-এ)

```sql
-- নতুন code (পুরনো link সঙ্গে সঙ্গে অচল হবে)
update public.app_settings set invite_code = 'নতুন-গোপন-code';

-- সর্বোচ্চ user সংখ্যা বদলানো
update public.app_settings set max_users = 8;

-- এখন কতজন user আছে
select count(*) from auth.users;
```

## ৬. Dashboard থেকে সরাসরি user বানাতে চাইলে

নিয়মিত পদ্ধতি হলো invite link। Dashboard-এর "Add user" দিয়ে বানাতে চাইলে trigger সাময়িক বন্ধ করতে হবে:

```sql
alter table auth.users disable trigger enforce_invite_signup;
-- Dashboard-এ user বানাও (email: তোমারid@privatedrop.invalid)
alter table auth.users enable trigger enforce_invite_signup;  -- সঙ্গে সঙ্গে আবার চালু
```

## Troubleshooting

- **Register করলে "Supabase rejected the internal email domain":** Supabase `.invalid` ধরনের test domain কখনো কখনো নেয় না। সমাধান: `script.js`-এ `EMAIL_DOMAIN` বদলাও এমন domain-এ যেটা তোমার নিজের এবং যেখানে কেউ mail নিতে পারে না, যেমন `privatedrop-users.তোমার-project.vercel.app`। পুরনো user-রা আগের মতোই login করতে পারবে (`LOGIN_DOMAINS` দুটোই চেষ্টা করে)।
- **"Account created, but auto sign-in is off":** Supabase-এ "Confirm email" বন্ধ করো।
- **"Registration failed":** link-এর code ভুল, user সীমা পূর্ণ, নয়তো ID আগেই নেওয়া। `setup.sql`-এ code বদলানো হয়েছে কিনা দেখো।
- **"Could not load files":** `setup.sql` পুরোটা run হয়েছে কিনা দেখো। Folder-এর জন্য `migration_002` আর `migration_003` দুটোই run করতে হয়।
- **ফাইলের নাম "(old / unreadable file)":** encryption চালুর আগের ফাইল। Delete করে নতুন করে upload করো।
- **Login-এ আটকে যায়:** ID বড়-ছোট হাতের অক্ষর একই ধরা হয়। Password ঠিক আছে কিনা দেখো।

## Test করার নিয়ম (real ফাইলের আগে)

1. Link দিয়ে test account খোলো, ছোট ফাইল upload করো।
2. অন্য browser বা device-এ আরেকটা account খুলে দেখো প্রথম account-এর ফাইল দেখা যায় না।
3. Supabase Storage খুলে দেখো ফাইলের নাম random, ভেতরের data পড়া যায় না।
4. Download করে ফাইল ঠিকমতো খোলে কিনা দেখো।
5. Download all আর Delete all চেষ্টা করো।

---

## নতুন: folder, folder upload, progress, preview

**আগের project চালু থাকলে** Supabase SQL Editor-এ এই দুটো file পরপর একবার করে run করো:
1. `supabase/migration_002_folders.sql` (আগে run করা থাকলে আবার লাগবে না)
2. `supabase/migration_003_private_folders.sql`

**একদম নতুন project হলে** শুধু `setup.sql` run করলেই হবে, দুটো migration ওটার ভেতরেই আছে।

কী কী যোগ হয়েছে:
- Nested folder, breadcrumb path, "Upload folder", drag-and-drop (file আর folder দুটোই), একসাথে অনেক file।
- প্রতি file-এর জন্য গোল progress circle (ভেতরে %), পাশাপাশি, ছোট নামসহ।
- File type অনুযায়ী icon: image (preview), video, audio, archive, folder। Text/document-এ আগের `▤` icon। ডানে format label (PDF, ZIP ইত্যাদি)।
- Newest/Oldest sort। Folder আগে, তারপর file।
- List ভেতরে scroll হয়। লম্বা নাম ডান থেকে বামে ঘোরে (প্রথম ২০টা), বাকিগুলো `নাম…` হয়ে এক লাইনে থাকে।
- Upload: encrypt করা binary সরাসরি Storage-এ, ৬ MB chunk করে (resumable), base64 নেই।

মনে রাখো:
- Folder-এর নামও encrypt হয়, আর প্রতি user-এর folder আলাদা (অন্যে দেখে না)।
- File encrypt করা, তাই download করলে browser-এ নামিয়ে decrypt করে save হয় (memory-তে, ≤ ৫০ MB)। Image preview-ও একইভাবে decrypt হয়, শুধু যেগুলো screen-এ দেখা যায় সেগুলোর, আর ২ MB পর্যন্ত।
- Download all / Delete all শুধু যে folder-এ আছো সেটার ভেতরের জিনিসের জন্য। Delete all সব subfolder-সহ মুছে।
- Resume শুধু network কেটে গেলে কাজ করে, tab বন্ধ করে আবার খুললে না।
- "Upload folder" বোতাম কিছু phone browser-এ কাজ নাও করতে পারে। Desktop-এ drag-and-drop আর বোতাম দুটোই চলে।
