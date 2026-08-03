#!/usr/bin/env node
import("tsx/esm/api").then(({register})=>{register();return import(new URL("../src/cli.ts",import.meta.url).href)});
