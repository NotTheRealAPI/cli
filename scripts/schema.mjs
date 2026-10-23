import { writeFile } from "node:fs/promises";
import { z } from "zod";
import * as p from "../dist/protocol.js";
import * as v2 from "../dist/protocol-v2.js";
const definitions = Object.fromEntries(
  Object.entries(p)
    .filter(([name]) => name.endsWith("Schema"))
    .map(([name, schema]) => [name, z.toJSONSchema(schema)]),
);
await writeFile(
  new URL("../docs/protocol-v1.schema.json", import.meta.url),
  JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://nottherealapi.com/contracts/listener/v1",
      $defs: definitions,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  new URL("../docs/protocol-v2.schema.json", import.meta.url),
  JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://nottherealapi.com/contracts/listener/v2",
      $comment:
        "Also enforce runtime constraints in listener-protocol-v2.md: safety denylist, case-insensitive unique headers, 8192 aggregate bytes, exact canonical HTTPS verificationUrl, canonical Base64/count/SHA-256 and lease/scope checks.",
      $defs: Object.fromEntries(
        Object.entries(v2)
          .filter(([name]) => name.endsWith("Schema"))
          .map(([name, schema]) => [name, z.toJSONSchema(schema)]),
      ),
    },
    null,
    2,
  ) + "\n",
);
