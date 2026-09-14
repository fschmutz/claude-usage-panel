// The two-line argv reader every script in this directory needs: the value
// after `--name`, or the fallback. Kept out of each script so it is written once.
export function flag(argv, name, fallback = null) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
