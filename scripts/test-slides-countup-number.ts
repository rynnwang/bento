#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// How the count-up reads and re-writes an authored number (#584).
//
//   node scripts/test-slides-countup-number.ts
//
// WHAT THIS PROVES — the maintainer's ruling of 2026-10-15 on #584, against
// slides/src/countnumber.ts, the code present.ts's runCountUp uses:
//   - a SINGLE dot is a decimal point: `12.500` is twelve point five, and the
//     count-up ticks through decimals (`7.811`) on the way to it;
//   - only a well-formed group pattern with TWO or more separators is
//     thousands: `1.250.000` settles as `1.250.000` (it used to settle as
//     `1250.000`), and its frames stay grouped (`625.000`);
//   - the comma conventions #171 fixed keep working, and mixed separators read
//     the last one as the decimal point.
// Frames are composed exactly as runCountUp composes them: value × progress,
// written back in the author's own shape.

import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { readNumber, writeNumber } = await import('../slides/src/countnumber.ts')

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }
const frame = (raw: string, p: number) => { const s = readNumber(raw); return writeNumber(s.value * p, s) }

console.log('\nthe ruling: one dot is a decimal point\n')
{
  const s = readNumber('12.500')
  ok(s.value === 12.5 && s.decimals === 3 && s.point === '.' && s.group === '', `12.500 reads as 12.5 to three places (${JSON.stringify(s)})`)
  ok(frame('12.500', 1) === '12.500', `and settles as authored (${frame('12.500', 1)})`)
  ok(/^\d+\.\d{3}$/.test(frame('12.500', 0.62)), `its frames are decimals, as the ruling says they should be (${frame('12.500', 0.62)})`)
  ok(readNumber('1.234').value === 1.234, '1.234 is one-point-two-three-four')
}

console.log('\nthe ruling: two or more well-formed separators are thousands\n')
{
  const s = readNumber('1.250.000')
  ok(s.value === 1250000 && s.group === '.' && s.point === '', `1.250.000 reads as 1,250,000 grouped by dots (${JSON.stringify(s)})`)
  ok(frame('1.250.000', 1) === '1.250.000', `and settles as authored, not 1250.000 (${frame('1.250.000', 1)})`)
  ok(frame('1.250.000', 0.5) === '625.000', `its frames stay grouped (${frame('1.250.000', 0.5)})`)
  ok(frame('12.345.678', 1) === '12.345.678' && readNumber('12.345.678').value === 12345678, 'a two-digit leading group works too')
  ok(readNumber('1.250.00').point === '.', 'a malformed group (1.250.00) is not read as thousands')
}

console.log('\nthe comma conventions (#171) and mixed separators\n')
{
  ok(readNumber('1,234,567').value === 1234567 && frame('1,234,567', 1) === '1,234,567', '1,234,567 groups by commas')
  ok(readNumber('1,234').value === 1234, 'a single comma before exactly three digits groups')
  ok(readNumber('1,5').value === 1.5 && frame('1,5', 1) === '1,5', 'otherwise a comma is the decimal point')
  ok(readNumber('1.234,5').value === 1234.5 && frame('1.234,5', 1) === '1.234,5', '1.234,5: the last separator is the decimal point')
  ok(readNumber('1,234.5').value === 1234.5 && frame('1,234.5', 1) === '1,234.5', '1,234.5: likewise')
}

console.log('\nwhat is not a number stays as authored\n')
{
  const { countPlan, isCountable } = await import('../slides/src/countnumber.ts')
  for (const raw of ['1.2.3', '192.168.1.1', '1,2,3', '1.2,3.4']) ok(!isCountable(raw), `"${raw}" is not a countable number`)
  for (const raw of ['42', '12.500', '1.250.000', '1,234,567', '1,5', '1.234,5', '1,234.5']) ok(isCountable(raw), `"${raw}" is`)
  const v = countPlan('Release 1.2.3 shipped to 1.250.000 users')!
  ok(v(0.5) === 'Release 1.2.3 shipped to 625.000 users' && v(1) === 'Release 1.2.3 shipped to 1.250.000 users',
    `a version beside a number: only the number counts (${v(0.5)})`)
  const ip = countPlan('Server 192.168.1.1 handled 12.500 requests')!
  ok(ip(1) === 'Server 192.168.1.1 handled 12.500 requests' && ip(0.5).startsWith('Server 192.168.1.1 handled '),
    `an address stays exactly as typed (${ip(0.5)})`)
  ok(countPlan('Version 1.2.3') === null && countPlan('No digits here') === null, 'text with nothing countable is not animated at all')
  ok(countPlan('grew 25.')!(1) === 'grew 25.', 'a sentence-ending full stop is kept')
}

console.log('\nthe count-up uses this code\n')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../slides/src/present.ts', import.meta.url), 'utf8')
  ok(/import \{ countPlan \} from '\.\/countnumber'/.test(src) && /const plan = countPlan\(/.test(src) && !/function (readNumber|writeNumber|countPlan)\(/.test(src),
    'present.ts runs its count-up through countnumber.ts countPlan and keeps no copy of its own')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
