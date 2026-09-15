# Casebook

A single-file case-interview coaching tracker. Pod leads score their mentees on
four dimensions — problem solving, analytical skills, communication, business
judgment — and track progress over time; mentees can log and track their own
self-assessments. Runs entirely as a Claude Artifact (`casebook.html`), backed
by the artifact's own database (no separate server).

## Data model

- `mentors` / `mentees` — the roster.
- `cases` — `{ menteeId, mentorId, caseName, date }`, one record per real
  case. Either the pod lead or the mentee can create it; the other party
  selects the existing record when they log their own score, so both sides'
  evaluations link to the same case.
- `evaluations` — one per scorecard: `{ mentorId, menteeId, source, caseId,
  date, caseName, notes, scores, rationale }`. `source` is `'mentor'` or
  `'self'`. `scores` holds one 1–10 number per category (or `null` for "not
  observed"). `rationale` holds a written justification per category, only
  for categories scored outside the 4–6 median band. Evaluations created
  before this shape existed still carry a `scores.<category>` object of
  15 sub-metric scores — the app reads both shapes.

### Blind entry & calibration

When a case has a `caseId`, the mentor's and the mentee's scores for it stay
hidden from each other until both have submitted. Once both exist, the app
computes a per-category and overall delta (self − mentor) and shows it to the
pod lead and in the admin overview — never to the mentee, so the gap reaches
them through a conversation with their pod lead rather than as a number to
game.

## Known pilot limitations

- **Identity is a name picker, not a login.** "Pod lead" vs. "mentee" and
  *which* pod lead or mentee you are is chosen from a list and remembered in
  `localStorage` — there is no authentication tying a browser session to a
  real person. Anyone with the artifact link can pick anyone's name,
  including a pod lead's. This is acceptable for a small trusted pilot group
  but is not an access-control boundary. Fixing it properly means adopting
  the artifact's `user` capability (real per-viewer identity) and rewriting
  role selection around it.
- **Case pairing has no dedup.** If both parties create a "new case" for the
  same real session instead of one of them selecting the other's existing
  record, two unlinked `cases` documents result and calibration silently
  won't pair them. There's no fuzzy name/date matching to paper over this —
  by design, per the refactor spec — so it relies on the two parties
  coordinating.
- **Scale anchors are placeholders.** Each category's 3/5/7/9 anchor text is
  a `TODO` in the `CATEGORIES` constant in `casebook.html`, waiting on the
  program leads to write real criterion language.

## Out of scope

Peer-to-peer scoring and any pairing/anti-match algorithm across mentees are
not implemented and not stubbed.
