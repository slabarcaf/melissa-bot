#!/usr/bin/env node
// Tests for the pure helpers in melissa.js. Run: npm test
//
// melissa.js calls start() at the top level, so it cannot simply be require()d —
// doing so would boot a second Telegram poller, and only one process may poll the
// token at a time. Instead we lift the declarations we want out of the source and
// evaluate them in isolation. This is the same "extract a function from the file
// and exercise it" technique the handoffs use to validate a deploy, so the tests
// always run against the real source rather than a copy that can drift.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'melissa.js'), 'utf8');

// Slice one top-level `function NAME(...)` or `const NAME = ...` declaration.
// Counting brackets does not work here: regex literals in the source contain
// things like {1,2}. Instead we rely on the file's formatting — a top-level
// declaration ends at the first line that is just a closing bracket at column 0.
const LINES = SRC.split('\n');

const isBalanced = s => {
  let d = 0;
  for (const c of s) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; }
  return d === 0;
};

function lift(name) {
  const re = new RegExp(`^(?:function ${name}\\(|const ${name} =)`);
  const i = LINES.findIndex(l => re.test(l));
  if (i === -1) throw new Error(`declaration not found: ${name}`);
  if (/;\s*$/.test(LINES[i]) && isBalanced(LINES[i])) return LINES[i]; // one-liner
  for (let j = i + 1; j < LINES.length; j++) {
    if (/^[}\]];?$/.test(LINES[j])) return LINES.slice(i, j + 1).join('\n');
  }
  throw new Error(`end of declaration not found: ${name}`);
}

const NAMES = [
  'PRESET_CATEGORIES', 'CITY_TZ_TABLE', 'TG_ALLOWED_TAGS',
  'parseCityToTimezone', 'parseCategorySelection', 'parseLanguageChoice',
  'parseBriefTimes', 'sanitizeName', 'toTelegramHtml', 'toPlainText', 'splitForTelegram',
];
const src = NAMES.map(lift).join('\n');
const M = new Function(`${src}\n return { ${NAMES.join(', ')} };`)();

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function is(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL  ${label}\n        got:  ${a}\n        want: ${e}`); }
}

// ── city → timezone ──────────────────────────────────────────────────────────
is(M.parseCityToTimezone('Santiago de Chile'), { tz: 'America/Santiago', matched: true }, 'Santiago');
is(M.parseCityToTimezone('Berkeley, USA'), { tz: 'America/Los_Angeles', matched: true }, 'Berkeley');
is(M.parseCityToTimezone('Dallas, Texas'), { tz: 'America/Chicago', matched: true }, 'Dallas');
is(M.parseCityToTimezone('America/Bogota'), { tz: 'America/Bogota', matched: true }, 'raw IANA string');
is(M.parseCityToTimezone('Tombuctu'), { tz: 'America/Los_Angeles', matched: false }, 'unknown city is flagged, not silently accepted');

// CITY_TZ_TABLE is order-sensitive: countries ending in "la" must be matched
// before the generic \bla\b → Los Angeles rule. Moving that row up would quietly
// put Caracas and Guatemala City on California time.
is(M.parseCityToTimezone('Caracas, Venezuela'), { tz: 'America/Caracas', matched: true }, 'Venezuela beats the \\bla\\b rule');
is(M.parseCityToTimezone('Guatemala'), { tz: 'America/Guatemala', matched: true }, 'Guatemala beats the \\bla\\b rule');
is(M.parseCityToTimezone('La Paz, Bolivia'), { tz: 'America/La_Paz', matched: true }, 'La Paz beats the \\bla\\b rule');

// ── language ─────────────────────────────────────────────────────────────────
is(M.parseLanguageChoice('español por favor'), 'es', 'language: español');
is(M.parseLanguageChoice('English'), 'en', 'language: English');
is(M.parseLanguageChoice('inglés'), 'en', 'language: inglés');
is(M.parseLanguageChoice('mmm no sé'), 'es', 'language: unrecognised defaults to es');

// ── brief times ──────────────────────────────────────────────────────────────
is(M.parseBriefTimes('7am y 8pm'), { morning: '07:00', evening: '20:00' }, 'briefs: 7am y 8pm');
is(M.parseBriefTimes('los dos, como recomiendas'), { morning: '07:00', evening: '20:00' }, 'briefs: defaults');
is(M.parseBriefTimes('solo en la mañana'), { morning: '07:00', evening: '' }, 'briefs: morning only');
is(M.parseBriefTimes('solo el de la noche a las 9'), { morning: '', evening: '21:00' }, 'briefs: evening only at 9');
is(M.parseBriefTimes('no quiero briefs'), { morning: '', evening: '' }, 'briefs: none');
is(M.parseBriefTimes('a las 7:30 y a las 21:00'), { morning: '07:30', evening: '21:00' }, 'briefs: explicit times');
is(M.parseBriefTimes('only one at 8pm'), { morning: '', evening: '20:00' }, 'briefs: English, evening only');
is(M.parseBriefTimes('7 y 8'), { morning: '07:00', evening: '20:00' }, 'briefs: bare hours, later one becomes PM');

// ── name sanitising (security F6) ────────────────────────────────────────────
is(M.sanitizeName('the second user'), 'the second user', 'name: plain');
is(M.sanitizeName('the second user Maria Gonzalez'), 'the second user', 'name: first token only');
is(M.sanitizeName('[uid:123] Eve'), 'uid123', 'name: strips a forged uid tag');
is(M.sanitizeName('   '), 'Amigo', 'name: empty falls back');
is(M.sanitizeName('x'.repeat(50)).length, 30, 'name: length capped');

// ── categories ───────────────────────────────────────────────────────────────
is(M.parseCategorySelection('1, 3').map(c => c.name), ['Work', 'Salud'], 'categories: by number');
is(M.parseCategorySelection('finanzas').map(c => c.name), ['Finanzas'], 'categories: by name, case-insensitive');
is(M.parseCategorySelection('nada de esto').length, 0, 'categories: no match returns empty (caller defaults)');

// ── Telegram HTML rendering ──────────────────────────────────────────────────
is(M.toTelegramHtml('✅ *TAREAS*'), '✅ <b>TAREAS</b>', 'html: bold');
is(M.toTelegramHtml('Ej: _"agrega tarea"_'), 'Ej: <i>"agrega tarea"</i>', 'html: italic');
is(M.toTelegramHtml('• Revisar <contrato> & firmar'), '• Revisar &lt;contrato&gt; &amp; firmar', 'html: escapes user content');
is(M.toTelegramHtml('id <code>123</code>'), 'id <code>123</code>', 'html: code span survives');
is(M.toTelegramHtml('2 * 3 y un * suelto'), '2 * 3 y un * suelto', 'html: stray asterisks left alone');

// The underscore rule must not fire inside IANA zone names, which appear in
// onboarding messages. Two of them in one message is the case that breaks a
// naive /_(.+)_/ rule.
is(M.toTelegramHtml('De America/Los_Angeles a America/New_York'),
   'De America/Los_Angeles a America/New_York', 'html: two IANA zones are not italicised');
is(M.toTelegramHtml('✅ Zona horaria: *America/Los_Angeles*'),
   '✅ Zona horaria: <b>America/Los_Angeles</b>', 'html: a zone can still be bolded');

is(M.toPlainText('✅ *TAREAS*'), '✅ TAREAS', 'plain: strips bold markers');
is(M.toPlainText('Zona: America/Los_Angeles'), 'Zona: America/Los_Angeles', 'plain: leaves zone intact');

// ── chunking ─────────────────────────────────────────────────────────────────
is(M.splitForTelegram('corto'), ['corto'], 'split: short text is one chunk');
{
  const long = Array.from({ length: 400 }, (_, i) => `• Tarea numero ${i} (3-Mar)`).join('\n');
  const chunks = M.splitForTelegram(long);
  is(chunks.every(c => c.length <= 3500), true, 'split: every chunk within limit');
  is(chunks.join('\n'), long, 'split: rejoins losslessly');
  is(chunks.every(c => c.endsWith(')')), true, 'split: never cuts mid-line');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
