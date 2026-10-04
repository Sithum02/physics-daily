# Physics Daily — how it works and how questions get added

Sithum doesn't edit files. In VS Code (this folder open) he tells Claude:

- "Add these 10 MCQs for today: …" (paste them)
- "Make 10 questions for tomorrow on current electricity"
- "Here are 30 questions, spread them over the next 3 days"
- "Q4 in today's set is wrong, the answer should be C" (everyone who took it is re-marked automatically)
- "Make 10 questions similar to these: …"

---

## How the app is built

| Part | Where | Public? |
|---|---|---|
| App (screens) | this folder → GitHub `Sithum02/physics-daily` → GitHub Pages | Public |
| Accounts, marks, leaderboards | Supabase (same project as the website) | Private (row-level security) |
| Questions **with answers** | `content/days/*.json` on this computer → uploaded into Supabase | **Private**. `content/` is git-ignored |
| Secret key for uploading | `tools/.env` | **Private**. Git-ignored, never share |
| Database code | `supabase/daily.sql` (safe to run again) | Public, no secrets |

Rules the database enforces: Sri Lanka date decides "today"; one attempt per student per day; 2 minutes
per question (10 → 20 min) timed on the server; options shuffled per student; answers only revealed after
submitting (or after the day ends); banned students blocked and hidden from boards.

Leaderboards (today / 7 days / 30 days / all-time): correct answers ÷ all questions released in the
period (missed days count as 0), ties broken by lower average time per quiz.

---

## For Claude: adding questions

### 1. Day file — `content/days/YYYY-MM-DD.json`

The date is the day it opens (00:00–23:59 Sri Lanka time). Future dates = scheduled.
Default 10 questions/day unless Sithum says otherwise.

```json
{
  "date": "2026-09-30",
  "title": "Current electricity",
  "questions": [
    {
      "id": "2026-09-30-01",
      "topic": "Current electricity",
      "q": "Text. x^{2} superscript, v_{0} subscript, **bold**, *italic*.",
      "options": ["A", "B", "C", "D", "E"],
      "answer": 2,
      "explain": "Worked method. End with the answer in **bold**.",
      "image": "img/q/2026-09-30-01.png"
    }
  ]
}
```

- `title` must be **`Quiz NN - <ordinal> <Mon> <YYYY>`**, e.g. `Quiz 01 - 1st Oct 2026` (Sithum's rule).
  Numbered one per day in date order from Quiz 01 = 1 Oct 2026 (29–30 Sep were trial days). No topic names in titles.
- Statement-style questions use **(A), (B), (C)** (Sithum's rule) with options like "A only", "A and B only",
  "A, B and C" (si: "A පමණි", "A හා B පමණි", "A, B හා C සියල්ලම"; ta: "A மாத்திரம்", "A உம் B உம் மாத்திரம்",
  "A, B, C ஆகிய எல்லாம்"). Put each statement on its own line (`\n`). The app numbers the answer options **1–5**
  (like the A/L paper), so refer to options by number in explanations.
- **Every question is trilingual**: English plus `"si"` (Sinhala) and `"ta"` (Tamil), each
  `{ "q": …, "options": [5, SAME ORDER as English], "explain": … }`. The answer index is shared, so the
  translated options must be in exactly the English order. Use the terms in `content/glossary.md`.
  Menus/buttons stay English. Students choose a language in Profile and can switch EN | සිං | தமி any time.
- `id` = `<date>-<NN>` in order (enforced). `answer` is 0-based (option 1 = 0 … option 5 = 4). Exactly 5 options.
- Diagrams: save the image to `img/q/<id>.png` (that folder IS public and gets pushed), set `"image"`.

### 2. Correctness rules

- Work every answer out fully; exactly one correct option; distractors = realistic mistakes.
- If Sithum's given answer looks wrong, **say so before publishing**.
- A/L (Sri Lanka) level, SI units, g = 10 m s⁻² unless stated. Keep Sinhala questions in Sinhala.
- Spread correct letters across A–E (the tool warns if lopsided). Options are shuffled per student anyway,
  but the review/admin screens show the original order.
- Don't delete or reorder questions of a day that is open or past (ids change → answers lost).
  Fix wording/answers in place; the upload re-marks everyone automatically.

### 3. Publish

```bash
node tools/publish.mjs          # validates all files, uploads changed days, re-marks attempts
node tools/publish.mjs --check  # validate only
node tools/publish.mjs 2026-09-30   # force re-upload of a day
```

Only if a diagram image was added, also push it (images are served from GitHub Pages):

```bash
git add img/q && git commit -m "Diagrams for 2026-09-30" && git push
```

### 4. App code changes

After changing `js/`, `*.css` or `index.html`: bump `VERSION` in `sw.js`, then commit and push.
Live about 1 minute later at https://sithum02.github.io/physics-daily/

### 5. Database changes

Edit `supabase/daily.sql` or `supabase/push.sql` (keep them re-runnable: `create or replace`,
`if not exists`) and run them directly — no copy-pasting needed:

```bash
node tools/supa.mjs sql supabase/daily.sql
```

### 6. Push reminders

- Sent by the Edge Function `supabase/functions/daily-push` (Deno, web-push, VAPID keys in `tools/.env`
  and Supabase secrets). Schedule (pg_cron): 6:00 am LK to everyone if there's a quiz; 8:00 pm LK only to
  students who haven't submitted. Admin can send custom messages from the app (Admin → Notify).
- Redeploy after editing the function or schedule: `node tools/supa.mjs push-setup`
- Test: `node tools/supa.mjs test-push "Title" "Body"` (or `morning` / `evening`).

### 7. Keys (tools/.env)

`SUPABASE_SERVICE_KEY` is a new-style `sb_secret_` key (goes in the `apikey` header only).
`SUPABASE_ACCESS_TOKEN` (`sbp_…`) is Sithum's personal token for the Management API and CLI.
The app and website use the publishable key `sb_publishable_…`. Legacy JWT keys are being disabled.
Never print these values; never ask Sithum to paste secrets into chat.
