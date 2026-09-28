#!/usr/bin/env node
// Seeds mentees/mentors and issues mentor bearer tokens via the Admin SDK.
// Run locally only — this needs a service-account key, never commit one.
//
//   node scripts/seed.mjs
//   node scripts/seed.mjs --rotate <mentorId>
//
// Env vars:
//   SERVICE_ACCOUNT_PATH   path to the service-account JSON (default: ./serviceAccount.json)
//   CASEBOOK_HOST          base URL casebook.html is served from, no trailing slash
//                          (default: https://REPLACE_WITH_YOUR_HOST)
//
// Inputs (both gitignored — they contain real names):
//   mentees.csv  columns: id,name,track,primaryMentorId,podId
//   mentors.csv  columns: id,name,podId,isAdmin

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((key, i) => { row[key.trim()] = (cells[i] ?? '').trim(); });
    return row;
  });
}

// Minimal RFC4180-ish splitter: handles quoted fields with embedded commas
// and doubled-quote escaping, which is as much as a roster CSV needs.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function genToken() {
  return randomBytes(24).toString('base64url');
}

function truthy(v) {
  return v === true || v === 'true' || v === '1' || v === 'yes' || v === 'TRUE';
}

function mentorUrl(host, mentorId, token, isAdmin) {
  const u = new URL(`${host}/casebook.html`);
  u.searchParams.set('m', mentorId);
  u.searchParams.set('t', token);
  if (isAdmin) u.searchParams.set('a', '1');
  return u.toString();
}

async function main() {
  const args = process.argv.slice(2);
  const rotateIdx = args.indexOf('--rotate');
  const rotateMentorId = rotateIdx !== -1 ? args[rotateIdx + 1] : null;

  const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH || 'serviceAccount.json';
  if (!existsSync(serviceAccountPath)) {
    console.error(`Missing service-account key at ${serviceAccountPath}.`);
    console.error('Download one from Firebase console > Project settings > Service accounts,');
    console.error('save it locally (it is gitignored), and re-run, or set SERVICE_ACCOUNT_PATH.');
    process.exit(1);
  }
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  const host = (process.env.CASEBOOK_HOST || 'https://REPLACE_WITH_YOUR_HOST').replace(/\/+$/, '');

  if (rotateMentorId) {
    await rotateToken(db, rotateMentorId, host);
    return;
  }

  if (!existsSync('mentees.csv') || !existsSync('mentors.csv')) {
    console.error('Expected mentees.csv and mentors.csv in the current directory. See the header');
    console.error('comment in this script for the expected columns.');
    process.exit(1);
  }

  const mentees = parseCsv(readFileSync('mentees.csv', 'utf8'));
  const mentors = parseCsv(readFileSync('mentors.csv', 'utf8'));

  console.log(`Seeding ${mentors.length} mentors and ${mentees.length} mentees...`);

  // mentees and mentors are small, idempotent overwrites — a plain set()
  // per doc is fine, batched in groups of <=500 (Firestore's batch limit).
  await writeInBatches(db, mentees.map((m) => ({
    ref: db.collection('mentees').doc(m.id),
    data: { name: m.name, track: m.track || null, primaryMentorId: m.primaryMentorId, podId: m.podId || null },
  })));
  await writeInBatches(db, mentors.map((m) => ({
    ref: db.collection('mentors').doc(m.id),
    data: { name: m.name, podId: m.podId || null },
  })));

  const urls = [];
  for (const m of mentors) {
    const isAdmin = truthy(m.isAdmin);
    const existing = await db.collection('mentorTokens').where('mentorId', '==', m.id).limit(1).get();
    let token;
    if (!existing.empty) {
      token = existing.docs[0].id;
      // Keep the stored isAdmin flag in sync with the roster CSV, since
      // a returning mentor's session already trusts whatever is here.
      await existing.docs[0].ref.set({ mentorId: m.id, isAdmin }, { merge: true });
    } else {
      token = genToken();
      await db.collection('mentorTokens').doc(token).set({ mentorId: m.id, isAdmin });
    }
    urls.push(`${m.name}\t${mentorUrl(host, m.id, token, isAdmin)}`);
  }

  writeFileSync('mentor-urls.txt', urls.join('\n') + '\n');
  console.log(`Wrote mentor-urls.txt with ${urls.length} personal links.`);
  console.log('Distribute each link individually, not in a group thread — it is a bearer credential.');
}

async function rotateToken(db, mentorId, host) {
  const mentorDoc = await db.collection('mentors').doc(mentorId).get();
  if (!mentorDoc.exists) {
    console.error(`No mentor with id "${mentorId}".`);
    process.exit(1);
  }
  const existing = await db.collection('mentorTokens').where('mentorId', '==', mentorId).get();
  const wasAdmin = existing.empty ? false : !!existing.docs[0].data().isAdmin;
  for (const doc of existing.docs) await doc.ref.delete();

  const token = genToken();
  await db.collection('mentorTokens').doc(token).set({ mentorId, isAdmin: wasAdmin });

  console.log(`Rotated token for ${mentorDoc.data().name} (${mentorId}).`);
  console.log('Every browser session created from the old token is now revoked.');
  console.log(mentorUrl(host, mentorId, token, wasAdmin));
}

async function writeInBatches(db, ops) {
  for (let i = 0; i < ops.length; i += 500) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 500)) batch.set(op.ref, op.data, { merge: true });
    await batch.commit();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
