// Every version this repo pins, read from the files that pin it. Pure: it takes
// the file contents and returns the pins, so tests run it over the real tree
// offline. A pin-shaped line that does not parse is an ERROR, never skipped:
// a pin the gate cannot read is a pin nobody is watching.
//
// One pin = {kind, name, current, file, ...kind-specific fields}:
//   action   owner/repo@<sha> # vX.Y.Z      (.github/workflows/*.yml)
//   hook     pre-commit `rev: <sha> # frozen: vX`   (.pre-commit-config.yaml)
//   npm      exact version in .github/<tool>/package.json
//   pip      name==version in .github/pre-commit/requirements.txt
//   docker   FROM image:tag@sha256:digest    (.github/<x>/Dockerfile)
//   node     a CI node-version, and the package.json engines floor

const SHA = /^[0-9a-f]{40}$/;

export function parseWorkflow(file, text) {
    const pins = [];
    const errors = [];
    for (const [i, line] of text.split('\n').entries()) {
        const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/);
        if (!m)
            continue;
        const ref = m[1];
        if (ref.startsWith('./') || ref.startsWith('docker://'))
            continue;
        const pin = ref.match(/^([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]+)$/);
        const ver = m[2].match(/^\s*#\s*(v?\d[\w.-]*)\s*$/);
        if (!pin || !SHA.test(pin[2]) || !ver) {
            errors.push(`${file}:${i + 1}: \`uses: ${ref}\` is not <owner/repo>@<40-hex sha> # <version>`);
            continue;
        }
        pins.push({kind: 'action', name: pin[1], current: ver[1], sha: pin[2], file});
    }
    for (const m of text.matchAll(/node-version:\s*\[?([^\]\n]+)\]?/g)) {
        for (const v of m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))) {
            if (/^\d+$/.test(v))
                pins.push({kind: 'node', name: 'node', current: v, file});
            else if (!v.startsWith('${{'))
                errors.push(`${file}: node-version ${v} is not a bare major`);
        }
    }
    for (const m of text.matchAll(/^\s*node:\s*\[([^\]]+)\]/gm)) {
        for (const v of m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')))
            pins.push({kind: 'node', name: 'node', current: v, file});
    }
    return {pins, errors};
}

export function parsePreCommit(file, text) {
    const pins = [];
    const errors = [];
    let repo = null;
    for (const [i, line] of text.split('\n').entries()) {
        const r = line.match(/^\s*-\s+repo:\s*(\S+)/);
        if (r) {
            repo = r[1];
            continue;
        }
        const m = line.match(/^\s+rev:\s*(\S+)(.*)$/);
        if (!m || !repo)
            continue;
        const gh = repo.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        const ver = m[2].match(/^\s*#\s*frozen:\s*(\S+)\s*$/);
        if (!gh || !SHA.test(m[1]) || !ver) {
            errors.push(`${file}:${i + 1}: rev of ${repo} is not <40-hex sha> # frozen: <tag> on a github.com repo`);
            continue;
        }
        pins.push({kind: 'hook', name: gh[1], current: ver[1], sha: m[1], file});
    }
    return {pins, errors};
}

export function parsePackageJson(file, text) {
    const pins = [];
    const errors = [];
    const json = JSON.parse(text);
    for (const field of ['dependencies', 'devDependencies']) {
        for (const [name, spec] of Object.entries(json[field] ?? {})) {
            if (/^\d+\.\d+\.\d+$/.test(spec))
                pins.push({kind: 'npm', name, current: spec, file});
            else
                errors.push(`${file}: ${name}@${spec} is not one exact version`);
        }
    }
    return {pins, errors};
}

export function parseEngines(file, text) {
    const floor = JSON.parse(text).engines?.node?.match(/^>=\s*(\d+)$/);
    return floor
        ? {pins: [{kind: 'node', name: 'node', current: floor[1], file, floor: true}], errors: []}
        : {pins: [], errors: [`${file}: engines.node is not ">=<major>"`]};
}

export function parseRequirements(file, text) {
    const pins = [];
    const errors = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line)
            continue;
        const m = line.match(/^([A-Za-z0-9._-]+)==([\w.]+)$/);
        if (m)
            pins.push({kind: 'pip', name: m[1], current: m[2], file});
        else
            errors.push(`${file}: \`${line}\` is not name==version`);
    }
    return {pins, errors};
}

export function parseDockerfile(file, text) {
    const pins = [];
    const errors = [];
    for (const line of text.split('\n')) {
        const m = line.match(/^FROM\s+(\S+)/i);
        if (!m)
            continue;
        const ref = m[1].match(/^([\w./-]+):([\w.-]+)@(sha256:[0-9a-f]{64})$/);
        if (!ref) {
            errors.push(`${file}: FROM ${m[1]} is not <image>:<tag>@sha256:<digest>`);
            continue;
        }
        pins.push({kind: 'docker', name: ref[1], current: ref[2], digest: ref[3], file});
    }
    return {pins, errors};
}

/**
 * The declared exceptions, `.github/dependency-holds`. One per line:
 *   <kind> <name> <version> <reason...>    held at <version>: the upstream
 *                                          release it was taken against; it
 *                                          expires when upstream moves on
 *   <kind> <name> track:<prefix> <reason>  compare only against releases
 *                                          whose version starts with <prefix>
 *   audit <package> <advisory-id> <reason> a known advisory, accepted
 * A line without a reason is malformed: a hold is a decision, and a decision
 * says why.
 */
export function parseHolds(text) {
    const holds = [];
    const errors = [];
    for (const [i, raw] of text.split('\n').entries()) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S.*)$/);
        // no `node` kind: a Node line is judged by its schedule (LTS, EOL),
        // never held
        if (!m || !['action', 'hook', 'npm', 'pip', 'docker', 'audit'].includes(m[1])) {
            errors.push(`dependency-holds:${i + 1}: expected <kind> <name> <version|track:prefix|advisory> <reason>`);
            continue;
        }
        const [, kind, name, at, reason] = m;
        const track = at.startsWith('track:') ? at.slice('track:'.length) : null;
        holds.push({kind, name, version: track ? null : at, track, reason, line: i + 1});
    }
    return {holds, errors};
}
