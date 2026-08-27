#!/usr/bin/env node
// Recommend session-ping times for a working day.
//
//   node scripts/plan-windows.mjs                       09:00-18:00, 2 pings
//   node scripts/plan-windows.mjs --day 08:30-19:00     custom day
//   node scripts/plan-windows.mjs --pings 3 --json      machine-readable
//   node scripts/plan-windows.mjs --compare 09:00,14:00 score a schedule you have
//
// Claude's 5-hour window is anchored to your first message, not the clock, so a
// 09:00 start fits only two full windows into a 09:00-18:00 day and the second
// runs out mid-afternoon. Pinging earlier re-anchors them. This prints WHEN;
// `./install.sh sessionping <times>` is what schedules them.
import {
    planWindows,
    evaluateWindows,
    parseHHMM,
    formatHHMM,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(
        'plan-windows: recommend session-ping times\n\n' +
            '  --day HH:MM-HH:MM   working day (default 09:00-18:00)\n' +
            '  --pings N           how many windows to plan (default 2)\n' +
            '  --compare a,b,c     score an existing schedule instead\n' +
            '  --json              machine-readable\n',
    );
    process.exit(0);
}

const dayArg = flag('--day', '09:00-18:00');
const [startRaw, endRaw] = String(dayArg).split('-');
const startMinute = parseHHMM(startRaw ?? '');
const endMinute = parseHHMM(endRaw ?? '');
if (startMinute === null || endMinute === null || endMinute <= startMinute) {
    process.stderr.write(`plan-windows: bad --day '${dayArg}' (want HH:MM-HH:MM)\n`);
    process.exit(2);
}
const day = {startMinute, endMinute};

const compare = flag('--compare');
const pings = Number(flag('--pings', '2'));
if (!Number.isFinite(pings) || pings < 1) {
    process.stderr.write('plan-windows: --pings wants a positive number\n');
    process.exit(2);
}

const recommended = planWindows(day, pings);
const current = compare ? evaluateWindows(String(compare).split(','), day) : null;
if (compare && !current) {
    process.stderr.write(`plan-windows: bad --compare '${compare}' (want HH:MM,HH:MM)\n`);
    process.exit(2);
}

if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({day, recommended, current}, null, 2) + '\n');
    process.exit(0);
}

const bar = (w) => {
    // One block per 30 min of the working day.
    const slots = Math.max(1, Math.round((day.endMinute - day.startMinute) / 30));
    let out = '';
    for (let i = 0; i < slots; i++) {
        const t = day.startMinute + i * 30;
        out += w.some((x) => t >= x.openMinute && t < x.openMinute + 300) ? '█' : '░';
    }
    return out;
};

process.stdout.write(`Working day  ${formatHHMM(startMinute)}-${formatHHMM(endMinute)}\n\n`);
if (current) {
    process.stdout.write(`Yours        ${bar(current.windows)}  ${current.coveragePercent}%\n`);
    process.stdout.write(`             ${current.pingTimes.join(' ')}\n\n`);
}
process.stdout.write(`Recommended  ${bar(recommended.windows)}  ${recommended.coveragePercent}%\n`);
process.stdout.write(`             ${recommended.pingTimes.join(' ')}\n\n`);
process.stdout.write(`  ./install.sh sessionping ${recommended.pingTimes.join(' ')}\n`);
