// Firestore security-rules tests, run against the emulator (never production).
// Invoke via `npm run test:rules`, which wraps this in `firebase emulators:exec`
// so the emulator is always up before the tests run and torn down after.

import { before, beforeEach, after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, serverTimestamp,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-casebook-test';
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8080;

const MENTOR_A = 'mentor-a';       // non-admin, primary mentor of MENTEE_A
const MENTOR_B = 'mentor-b';       // non-admin, primary mentor of MENTEE_B (different pod)
const MENTOR_ADMIN = 'mentor-admin';
const MENTEE_A = 'mentee-a';
const MENTEE_B = 'mentee-b';
const MENTEE_C = 'mentee-c';        // also MENTOR_B's pod, for testing a grant doesn't leak to an ungranted mentee
const TOKEN_A = 'token-a-0000000000000000000000';
const TOKEN_B = 'token-b-0000000000000000000000';
const TOKEN_ADMIN = 'token-admin-000000000000000';
const UID_A = 'uid-mentor-a';
const UID_B = 'uid-mentor-b';
const UID_ADMIN = 'uid-mentor-admin';
const CASE_A1 = 'case-a1';         // belongs to MENTEE_A / MENTOR_A
const CASE_B1 = 'case-b1';         // belongs to MENTEE_B / MENTOR_B, for cross-pod tests

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: EMULATOR_HOST,
      port: EMULATOR_PORT,
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedBaseFixtures();
});

async function seedBaseFixtures() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'mentees', MENTEE_A), { name: 'Mentee A', track: 'FT', primaryMentorId: MENTOR_A, podId: 'pod-a' });
    await setDoc(doc(db, 'mentees', MENTEE_B), { name: 'Mentee B', track: 'FT', primaryMentorId: MENTOR_B, podId: 'pod-b' });
    await setDoc(doc(db, 'mentees', MENTEE_C), { name: 'Mentee C', track: 'FT', primaryMentorId: MENTOR_B, podId: 'pod-b' });
    await setDoc(doc(db, 'mentors', MENTOR_A), { name: 'Mentor A', podId: 'pod-a' });
    await setDoc(doc(db, 'mentors', MENTOR_B), { name: 'Mentor B', podId: 'pod-b' });
    await setDoc(doc(db, 'mentors', MENTOR_ADMIN), { name: 'Admin Mentor', podId: 'pod-a' });
    await setDoc(doc(db, 'mentorTokens', TOKEN_A), { mentorId: MENTOR_A, isAdmin: false });
    await setDoc(doc(db, 'mentorTokens', TOKEN_B), { mentorId: MENTOR_B, isAdmin: false });
    await setDoc(doc(db, 'mentorTokens', TOKEN_ADMIN), { mentorId: MENTOR_ADMIN, isAdmin: true });
    await setDoc(doc(db, 'cases', CASE_A1), {
      menteeId: MENTEE_A, primaryMentorId: MENTOR_A, caseName: 'Market entry', date: '2026-09-01',
      createdBy: 'mentee', createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'cases', CASE_B1), {
      menteeId: MENTEE_B, primaryMentorId: MENTOR_B, caseName: 'Profitability', date: '2026-09-02',
      createdBy: 'mentee', createdAt: serverTimestamp(),
    });
  });
}

/** Creates a mentor session through the REAL rules (not a bypass) — this
 * doubles as continuous coverage of the "valid session create succeeds"
 * path every time a test uses it as setup. */
async function createSession(uid, mentorId, token, isAdmin) {
  const ctx = testEnv.authenticatedContext(uid);
  const db = ctx.firestore();
  await assertSucceeds(setDoc(doc(db, 'mentorSessions', uid), { token, mentorId, isAdmin }));
  return ctx;
}

function scores(overrides = {}) {
  return { ps: 5, analytical: 5, comm: 5, biz: 5, ...overrides };
}

function selfEvalPayload(overrides = {}) {
  return {
    caseId: CASE_A1, menteeId: MENTEE_A, primaryMentorId: MENTOR_A, source: 'self',
    scores: scores(), date: '2026-09-01', caseName: 'Market entry', createdAt: serverTimestamp(),
    ...overrides,
  };
}

function mentorEvalPayload(overrides = {}) {
  return {
    caseId: CASE_A1, menteeId: MENTEE_A, primaryMentorId: MENTOR_A, scorerId: MENTOR_A, source: 'mentor',
    scores: scores(), date: '2026-09-01', caseName: 'Market entry', createdAt: serverTimestamp(),
    ...overrides,
  };
}

// ============================================================
// Mentee (unauthenticated)
// ============================================================
describe('mentee (unauthenticated)', () => {
  it('can read mentees, mentors, and cases', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'mentees', MENTEE_A)));
    await assertSucceeds(getDocs(collection(db, 'mentors')));
    await assertSucceeds(getDoc(doc(db, 'cases', CASE_A1)));
    await assertSucceeds(getDocs(collection(db, 'cases')));
  });

  it('can create a valid case', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(setDoc(doc(collection(db, 'cases')), {
      menteeId: MENTEE_A, primaryMentorId: MENTOR_A, caseName: 'New case', date: '2026-09-10',
      createdBy: 'mentee', createdAt: serverTimestamp(),
    }));
  });

  it('can create a valid self-evaluation', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload()));
  });

  it('cannot read any evaluations or self-evaluations doc, get or list', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const adminDb = ctx.firestore();
      await setDoc(doc(adminDb, 'selfEvaluations', CASE_A1), selfEvalPayload());
      await setDoc(doc(adminDb, 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`), mentorEvalPayload());
    });
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'selfEvaluations', CASE_A1)));
    await assertFails(getDocs(collection(db, 'selfEvaluations')));
    await assertFails(getDoc(doc(db, 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`)));
    await assertFails(getDocs(collection(db, 'evaluations')));
  });

  it("cannot create a case or self-eval with a primaryMentorId that doesn't match the mentee doc", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(collection(db, 'cases')), {
      menteeId: MENTEE_A, primaryMentorId: MENTOR_B, // wrong mentor for MENTEE_A
      caseName: 'x', date: '2026-09-10', createdBy: 'mentee', createdAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ primaryMentorId: MENTOR_B })));
  });

  it("cannot create a self-eval whose caseId belongs to a different mentee", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    // CASE_A1 really belongs to MENTEE_A; claiming MENTEE_B here must fail refsOk().
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ menteeId: MENTEE_B, primaryMentorId: MENTOR_B })));
  });

  it('cannot create a second self-evaluation for the same case', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload()));
    // The doc now exists, so a second set() is an update — nothing grants that.
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ notes: 'try again' })));
  });

  it('cannot create a score of 0, 11, 5.5, or a string', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ scores: scores({ ps: 0 }) })));
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ scores: scores({ ps: 11 }) })));
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ scores: scores({ ps: 5.5 }) })));
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ scores: scores({ ps: '5' }) })));
  });

  it('cannot submit a score of 9 or 2 without a rationale of at least 10 chars', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ scores: scores({ ps: 9 }) })));
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1),
      selfEvalPayload({ scores: scores({ ps: 9 }), rationale: { ps: 'too short' } }))); // 9 chars
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), selfEvalPayload({ scores: scores({ biz: 2 }) })));
    // exactly 10 non-space characters is the floor, and must succeed
    await assertSucceeds(setDoc(doc(db, 'selfEvaluations', CASE_A1),
      selfEvalPayload({ scores: scores({ ps: 9 }), rationale: { ps: '1234567890' } })));
  });

  it('can submit scores 4 to 6 with no rationale, and null scores', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(setDoc(doc(db, 'selfEvaluations', CASE_A1),
      selfEvalPayload({ scores: { ps: 4, analytical: 6, comm: null, biz: 5 } })));
  });

  it('cannot write extra keys, or write mentors, mentees, mentorTokens, mentorSessions', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'selfEvaluations', CASE_A1), { ...selfEvalPayload(), extra: 'nope' }));
    await assertFails(setDoc(doc(db, 'mentees', MENTEE_A), { name: 'hacked' }, { merge: true }));
    await assertFails(setDoc(doc(db, 'mentors', MENTOR_A), { name: 'hacked' }, { merge: true }));
    await assertFails(setDoc(doc(db, 'mentorTokens', TOKEN_A), { mentorId: 'x', isAdmin: true }));
    await assertFails(setDoc(doc(db, 'mentorSessions', 'some-uid'), { token: TOKEN_A, mentorId: MENTOR_A, isAdmin: false }));
  });
});

// ============================================================
// Mentor
// ============================================================
describe('mentor', () => {
  it('session create fails with a bad token', async () => {
    const db = testEnv.authenticatedContext(UID_A).firestore();
    await assertFails(setDoc(doc(db, 'mentorSessions', UID_A), { token: 'not-a-real-token', mentorId: MENTOR_A, isAdmin: false }));
  });

  it('session create fails with a mismatched mentorId', async () => {
    const db = testEnv.authenticatedContext(UID_A).firestore();
    await assertFails(setDoc(doc(db, 'mentorSessions', UID_A), { token: TOKEN_A, mentorId: MENTOR_B, isAdmin: false }));
  });

  it('session create fails with a mismatched isAdmin', async () => {
    const db = testEnv.authenticatedContext(UID_A).firestore();
    await assertFails(setDoc(doc(db, 'mentorSessions', UID_A), { token: TOKEN_A, mentorId: MENTOR_A, isAdmin: true }));
  });

  it('session create fails with a different uid than the caller', async () => {
    const db = testEnv.authenticatedContext(UID_A).firestore();
    await assertFails(setDoc(doc(db, 'mentorSessions', 'someone-else'), { token: TOKEN_A, mentorId: MENTOR_A, isAdmin: false }));
  });

  it('valid session create succeeds; deleting the token doc then revokes reads', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertSucceeds(getDocs(query(collection(dbA, 'evaluations'), where('primaryMentorId', '==', MENTOR_A))));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'mentorTokens', TOKEN_A));
    });

    await assertFails(getDocs(query(collection(dbA, 'evaluations'), where('primaryMentorId', '==', MENTOR_A))));
  });

  it('can create an evaluation for a mentee outside their pod, with scorerId equal to their own id', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertSucceeds(setDoc(doc(dbA, 'evaluations', `${CASE_B1}_mentor_${MENTOR_A}`),
      mentorEvalPayload({ caseId: CASE_B1, menteeId: MENTEE_B, primaryMentorId: MENTOR_B, scorerId: MENTOR_A })));
  });

  it("cannot create an evaluation with someone else's scorerId or a wrong doc ID", async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertFails(setDoc(doc(dbA, 'evaluations', `${CASE_A1}_mentor_${MENTOR_B}`),
      mentorEvalPayload({ scorerId: MENTOR_B })));
    await assertFails(setDoc(doc(dbA, 'evaluations', 'not-the-right-id'), mentorEvalPayload()));
  });

  it('can read evaluations only via a query constrained to their own primaryMentorId; an unconstrained or other-pod query is rejected', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertSucceeds(getDocs(query(collection(dbA, 'evaluations'), where('primaryMentorId', '==', MENTOR_A))));
    await assertFails(getDocs(collection(dbA, 'evaluations')));
    await assertFails(getDocs(query(collection(dbA, 'evaluations'), where('primaryMentorId', '==', MENTOR_B))));
  });

  it('cannot get a selfEvaluations doc before submitting their own evaluation for that case; can immediately after', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'selfEvaluations', CASE_A1), selfEvalPayload());
    });

    await assertFails(getDoc(doc(dbA, 'selfEvaluations', CASE_A1)));

    await assertSucceeds(setDoc(doc(dbA, 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`), mentorEvalPayload()));

    await assertSucceeds(getDoc(doc(dbA, 'selfEvaluations', CASE_A1)));
  });

  it("cannot list selfEvaluations, and cannot read another pod's self-evals at all", async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertFails(getDocs(collection(dbA, 'selfEvaluations')));

    // Mentor A scores a case for Mentee B (cross-pod) but is not Mentee B's
    // primary mentor, so Mentee B's self-eval must stay unreadable regardless.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'selfEvaluations', CASE_B1),
        selfEvalPayload({ caseId: CASE_B1, menteeId: MENTEE_B, primaryMentorId: MENTOR_B }));
    });
    await assertSucceeds(setDoc(doc(dbA, 'evaluations', `${CASE_B1}_mentor_${MENTOR_A}`),
      mentorEvalPayload({ caseId: CASE_B1, menteeId: MENTEE_B, primaryMentorId: MENTOR_B, scorerId: MENTOR_A })));
    await assertFails(getDoc(doc(dbA, 'selfEvaluations', CASE_B1)));
  });

  it('cannot update or delete anything', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`), mentorEvalPayload());
    });
    await assertFails(updateDoc(doc(dbA, 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`), { notes: 'edited' }));
    await assertFails(deleteDoc(doc(dbA, 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`)));
    await assertFails(updateDoc(doc(dbA, 'cases', CASE_A1), { caseName: 'edited' }));
    await assertFails(deleteDoc(doc(dbA, 'mentees', MENTEE_A)));
  });
});

// ============================================================
// Cross-pod access grants
// ============================================================
describe('cross-pod access', () => {
  it('a mentor can grant themselves access to a mentee outside their pod', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertSucceeds(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_A}_${MENTEE_B}`),
      { mentorId: MENTOR_A, menteeId: MENTEE_B }));
  });

  it('cannot grant access claiming a different mentorId, a nonexistent mentee, a mismatched doc id, or extra keys', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertFails(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_B}_${MENTEE_B}`),
      { mentorId: MENTOR_B, menteeId: MENTEE_B })); // claiming someone else's mentorId
    await assertFails(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_A}_nonexistent-mentee`),
      { mentorId: MENTOR_A, menteeId: 'nonexistent-mentee' }));
    await assertFails(setDoc(doc(dbA, 'crossPodAccess', 'wrong-id'),
      { mentorId: MENTOR_A, menteeId: MENTEE_B }));
    await assertFails(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_A}_${MENTEE_B}`),
      { mentorId: MENTOR_A, menteeId: MENTEE_B, extra: 'nope' }));
  });

  it("a mentor can re-affirm their own existing grant, but cannot change its menteeId or update another mentor's grant", async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await assertSucceeds(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_A}_${MENTEE_B}`),
      { mentorId: MENTOR_A, menteeId: MENTEE_B }));
    // doc now exists, so this re-set is an "update" against the same grant
    await assertSucceeds(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_A}_${MENTEE_B}`),
      { mentorId: MENTOR_A, menteeId: MENTEE_B }));
    // cannot repoint an existing grant at a different mentee
    await assertFails(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_A}_${MENTEE_B}`),
      { mentorId: MENTOR_A, menteeId: MENTEE_A }));

    const dbB = (await createSession(UID_B, MENTOR_B, TOKEN_B, false)).firestore();
    await assertFails(setDoc(doc(dbB, 'crossPodAccess', `${MENTOR_A}_${MENTEE_B}`),
      { mentorId: MENTOR_A, menteeId: MENTEE_B }));
  });

  it('after granting access, a mentor can read that mentee\'s evaluations via a menteeId-scoped query, but not unconstrained, and not for a different ungranted mentee', async () => {
    const dbA = (await createSession(UID_A, MENTOR_A, TOKEN_A, false)).firestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'evaluations', `${CASE_B1}_mentor_${MENTOR_B}`),
        mentorEvalPayload({ caseId: CASE_B1, menteeId: MENTEE_B, primaryMentorId: MENTOR_B, scorerId: MENTOR_B }));
    });

    // no grant yet: the menteeId-scoped query is rejected
    await assertFails(getDocs(query(collection(dbA, 'evaluations'), where('menteeId', '==', MENTEE_B))));

    await assertSucceeds(setDoc(doc(dbA, 'crossPodAccess', `${MENTOR_A}_${MENTEE_B}`),
      { mentorId: MENTOR_A, menteeId: MENTEE_B }));

    // now the scoped query succeeds and returns Mentor B's evaluation for Mentee B
    const snap = await assertSucceeds(getDocs(query(collection(dbA, 'evaluations'), where('menteeId', '==', MENTEE_B))));
    if (snap.size !== 1) throw new Error(`expected 1 evaluation for MENTEE_B, got ${snap.size}`);

    // an unconstrained read is still rejected even with a grant in hand
    await assertFails(getDocs(collection(dbA, 'evaluations')));

    // the grant is scoped to MENTEE_B only — it must not leak to MENTEE_C, who has no grant
    await assertFails(getDocs(query(collection(dbA, 'evaluations'), where('menteeId', '==', MENTEE_C))));
  });
});

// ============================================================
// Admin
// ============================================================
describe('admin', () => {
  it('can read and list everything, and update/delete evaluations', async () => {
    const dbAdmin = (await createSession(UID_ADMIN, MENTOR_ADMIN, TOKEN_ADMIN, true)).firestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`), mentorEvalPayload());
      await setDoc(doc(ctx.firestore(), 'selfEvaluations', CASE_A1), selfEvalPayload());
    });

    await assertSucceeds(getDocs(collection(dbAdmin, 'evaluations')));
    await assertSucceeds(getDocs(collection(dbAdmin, 'selfEvaluations')));
    await assertSucceeds(getDoc(doc(dbAdmin, 'selfEvaluations', CASE_A1)));
    await assertSucceeds(updateDoc(doc(dbAdmin, 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`), { notes: 'admin edit' }));
    await assertSucceeds(deleteDoc(doc(dbAdmin, 'evaluations', `${CASE_A1}_mentor_${MENTOR_A}`)));
  });
});
