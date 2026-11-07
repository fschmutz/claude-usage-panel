// The one "run when executed directly" test of the Node entry points (the
// status line, the hooks, claudectl, the MCP server, the Awake holder).
// Importing one of them, from a test or another module, must stay side-effect
// free; running it - by its path, through a symlink (an npm/npx bin shim in
// node_modules/.bin, a dotfiles link) or from the installed tree - must run it.
// Node resolves import.meta.url through symlinks, so argv[1] is compared by
// its real path too. A suffix match (`endsWith('x.js')`) also fired for any
// other script whose name merely ended the same way.

import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

/** True when the module at `metaUrl` (its import.meta.url) is the script
 *  node was started with. */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return pathToFileURL(fs.realpathSync(argv1)).href === metaUrl;
  } catch {
    return false;
  }
}
