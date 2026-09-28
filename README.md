# Casebook

A single-file case-interview coaching tracker, backed by Firestore. Pod leads
score their mentees on four dimensions — problem solving, analytical skills,
communication, business judgment — and track progress over time. Mentees can
log and track their own self-assessments through a write-only flow with no
login. Access control (who can read what) is enforced by
[`firestore.rules`](firestore.rules), not by the client.

## Access model

| Actor | Gets in via | Can write | Can read |
|---|---|---|---|
| **Mentee** | One shared link, no params. Picks their name from a list. No auth. | Create a case; one self-evaluation per case | Public roster (`mentees`, `mentors`) and public `cases` (names/dates only). Nothing else — not even their own scoring history. |
| **Pod lead** | Personal link `casebook.html?m=<mentorId>&t=<token>`. Silent anonymous sign-in, then a token check — no Google sign-in, no prompt. | Create a case; score any mentee (even outside their pod) | Evaluations for **their own pod only** (`primaryMentorId`-scoped queries). A mentee's self-evaluation for a case only **after** the pod lead has submitted their own score for that same case. |
| **Admin** | Same personal-link flow, with the token flagged `isAdmin` | Everything a pod lead can, plus rules-level admin access | Everything |

A mentor's personal link carries an optional `&a=1` for admin tokens (added
by `seed.mjs`). The client can't read `mentorTokens` to know its own admin
status, so it *claims* `isAdmin` from the URL on first bootstrap and the
security rules verify that claim against the real token record before
creating the session; every visit after that reads `isAdmin` back from the
stored session, never from the URL again. Revoke a pod lead's access by
deleting their `mentorTokens` document (`npm run seed -- --rotate <mentorId>`
issues a fresh one).

## Data model

- **`mentees/{id}`**, **`mentors/{id}`** — public read, no client writes.
  Seeded via `npm run seed` from `mentees.csv` / `mentors.csv`.
- **`mentorTokens/{token}`** — `{ mentorId, isAdmin }`. No client access at
  all; the rules reach it only through `get()`/`exists()`.
- **`mentorSessions/{authUid}`** — created by the pod lead's own browser on
  first visit: `{ token, mentorId, isAdmin }`, verified against
  `mentorTokens` at write time.
- **`cases/{caseId}`** — `{ menteeId, primaryMentorId, caseName, date,
  createdBy, createdAt }`, public read. Either party can create one; the
  other picks the existing record instead of retyping the case, which is
  what lets their two scorecards pair up for calibration.
- **`evaluations/{caseId}_mentor_{scorerId}`** — a pod lead's scorecard:
  `{ caseId, menteeId, primaryMentorId, scorerId, source: 'mentor', scores,
  rationale, date, caseName, notes, createdAt }`. The deterministic doc ID
  caps it at one score per (case, scorer) pair — a repeat attempt is an
  "update" against an existing document, which nothing grants.
- **`selfEvaluations/{caseId}`** — a mentee's own scorecard, same shape with
  `source: 'self'` and no `scorerId`. Doc ID is the bare `caseId`, so a
  second self-log for the same case is likewise a denied "update".
- `scores` holds one 1–10 integer per category, or `null` for "not
  observed". `rationale` holds a required ≥10-character justification per
  category scored outside the 4–6 median band.

### Blind entry & calibration

A case's mentor-scored and self-scored entries stay hidden from each other
until both exist. For the mentee this is a hard query-time boundary — their
browser is never granted a read path to `evaluations` at all. For the pod
lead it's enforced per case: reading a mentee's `selfEvaluations` doc
requires `exists()` on that pod lead's own `evaluations` doc for the same
case, so it only opens up once they've submitted their own score.

Once both sides exist, the app computes a per-category and overall delta
(self − mentor) and shows it to the pod lead and in the admin overview —
never to the mentee, so the gap reaches them through a conversation with
their pod lead rather than as a number to game.

## Setup (the parts Claude Code can't do for you)

1. Create a Firebase project (Spark plan is enough — no Cloud Functions are
   used). Enable **Firestore** (production mode) and **Authentication →
   Anonymous**.
2. Paste the web app config into `FIREBASE_CONFIG` near the top of
   `casebook.html`'s script — Project settings → General → Your apps. This
   config names the project; it isn't a secret.
3. Install the CLI deps and log in: `npm install`, then `npx firebase login`.
4. Point `.firebaserc`'s `default` project at your real project ID.
5. **Run the rules tests before deploying anything** — they need a local
   JRE for the Firestore emulator (`brew install openjdk`, or any JDK 11+):
   `npm run test:rules`. Fix anything that fails before proceeding.
6. Deploy: `npx firebase deploy --only firestore:rules,firestore:indexes`.
   Deploy hosting too if you want Firebase to serve the file:
   `npx firebase deploy --only hosting`. (Any static host works — the app
   doesn't depend on Firebase Hosting specifically.)
7. Download a service-account key for seeding (Project settings → Service
   accounts). Keep it out of the repo — it's gitignored by pattern, but
   double-check before committing.
8. Prepare `mentees.csv` (`id,name,track,primaryMentorId,podId`) and
   `mentors.csv` (`id,name,podId,isAdmin`) — also gitignored, since they
   carry real names.
9. Seed: `SERVICE_ACCOUNT_PATH=./serviceAccount.json CASEBOOK_HOST=https://your-host npm run seed`.
   This writes `mentor-urls.txt` with one personal link per pod lead —
   **distribute each individually, not in a group thread; it's a bearer
   credential.** Re-running is idempotent (existing tokens aren't rotated);
   use `npm run seed -- --rotate <mentorId>` to revoke and reissue one.
10. Share the bare `casebook.html` URL (no query params) with mentees.

## Known pilot limitations

- **Bearer-token access, not real login.** A pod lead's link IS their
  credential — anyone who has it has that pod lead's access, admin flag
  included. There's no password, no revocation trail beyond deleting the
  token doc, and a leaked link (screenshot, forwarded email) is a leaked
  session until you rotate it.
- **`cases` is publicly listable.** Names and dates only, no scores — but
  enough to see case titles across the whole program, including other pods.
- **The mentee link can be reused to view any name.** A mentee's link
  doesn't tie to a specific person; anyone with the link can pick anyone's
  name from the roster and log sessions as them. Combined with write-only
  access this is low-stakes (no scores to leak), but it isn't identity
  verification.
- **Mentees have no history view in v1.** By design (write-only) — the
  optional local receipt list (last 20 sessions, device-local, no scores) is
  the only trace they see of what they've logged.
- **Case pairing has no dedup.** If both parties create a "new case" for the
  same real session instead of one of them picking the other's existing
  record, two unlinked `cases` documents result and calibration silently
  won't pair them — there's no fuzzy name/date matching to paper over it.
  Relies on the two parties coordinating (e.g., the pod lead logs the case
  while the mentee is still there).
- **Scale anchors are placeholders.** Each category's 3/5/7/9 anchor text is
  a `TODO` in the `CATEGORIES` constant in `casebook.html`, waiting on the
  program leads to write real criterion language.
- **The Firebase web config is public by design** (`FIREBASE_CONFIG` in
  `casebook.html`) — it names the project, it doesn't grant access; actual
  access control lives entirely in `firestore.rules`.

## Out of scope

Peer-to-peer scoring (the `source` field is a string enum specifically so
`'peer'` can be added later), any pairing/anti-match algorithm across
mentees, and migrating data from the old Claude-artifact-backed version —
none of it is implemented or stubbed.

## Repo layout

```
casebook.html          the whole app — UI, rendering, Firestore client calls
firestore.rules         access control (read this file to know what's actually enforced)
firestore.indexes.json  composite indexes the client's queries need
firebase.json           rules/indexes/hosting config for the Firebase CLI
scripts/seed.mjs        roster + token seeding, run locally with the Admin SDK
test/rules.test.mjs     the rules test suite (npm run test:rules)
```
