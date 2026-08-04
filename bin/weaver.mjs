#!/usr/bin/env node
// Global-install shim (`ln -s .../bin/weaver.mjs /opt/homebrew/bin/weaver`):
// resolves through the symlink to its own repo, so `weaver` works from any
// directory against this repo's state unless WEAVER_HOME says otherwise.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
process.env.WEAVER_HOME ??= join(here, "..", "state");
const { register } = await import(join(here, "..", "node_modules", "tsx", "dist", "esm", "api", "index.mjs"));
register();
await import(new URL("file://" + join(here, "..", "src", "cli.ts")).href);
