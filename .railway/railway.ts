import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

export default defineRailway(() => {
  // These names deliberately match the production resources. Railway IaC
  // binds existing resources by name instead of creating parallel services.
  const database = postgres("Postgres");
  const ui = service("ui", {
    source: github("NiallBrickell/weaver", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    // Docker start overrides replace ENTRYPOINT/CMD. The shell is required for
    // Railway's injected PORT to expand; exec keeps Weaver itself as PID 1.
    start: '/bin/sh -c "exec node bin/weaver.mjs ui --host 0.0.0.0 --port $PORT"',
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    replicas: 1,
    deploy: {
      restartPolicyType: "ALWAYS",
      sleepApplication: false,
      drainingSeconds: 30,
    },
    env: {
      WEAVER_STORE: database.env.DATABASE_URL,
      WEAVER_UI_TOKEN: preserve(),
      WEAVER_HOUSE_JSON: preserve(),
    },
  });

  return project("weaver", {
    resources: [database, ui],
  });
});
