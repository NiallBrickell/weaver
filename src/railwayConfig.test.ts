import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRailwayContext, project } from "railway/iac";

test("Railway IaC pins the shared store and UI deployment contract", async () => {
  const moduleUrl = pathToFileURL(`${process.cwd()}/.railway/railway.ts`).href;
  const configuration = (await import(moduleUrl)) as {
    default: (
      context: ReturnType<typeof createRailwayContext>,
      projectHelper: typeof project,
    ) => unknown;
  };

  const desired = (await configuration.default(
    createRailwayContext({ environment: "production" }),
    project,
  )) as {
    name: string;
    resources: Array<Record<string, unknown>>;
  };

  assert.equal(desired.name, "weaver");
  assert.deepEqual(
    desired.resources.map((resource) => [resource.type, resource.name]),
    [
      ["database", "Postgres"],
      ["service", "ui"],
    ],
  );

  const ui = desired.resources[1] as {
    build: Record<string, unknown>;
    deploy: Record<string, unknown>;
    source: Record<string, unknown>;
    variables: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(ui.source, {
    type: "github",
    repo: "NiallBrickell/weaver",
    branch: "main",
  });
  assert.deepEqual(ui.build, {
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile",
  });
  assert.deepEqual(ui.deploy, {
    startCommand: '/bin/sh -c "exec node bin/weaver.mjs ui --host 0.0.0.0 --port $PORT"',
    healthcheckPath: "/healthz",
    healthcheckTimeout: 30,
    numReplicas: 1,
    restartPolicyType: "ALWAYS",
    sleepApplication: false,
    drainingSeconds: 30,
  });
  assert.deepEqual(ui.variables.WEAVER_STORE, {
    type: "reference",
    resource: "database.Postgres",
    output: "DATABASE_URL",
  });
  assert.deepEqual(ui.variables.WEAVER_UI_TOKEN, { type: "preserve" });
  assert.deepEqual(ui.variables.WEAVER_HOUSE_JSON, { type: "preserve" });
});
