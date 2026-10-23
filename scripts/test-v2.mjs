import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["--test", "test/e2e.test.mjs", "test/notifications.test.mjs"],
  {
    env: { ...process.env, NTAPI_TEST_PROTOCOL: "v2" },
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
