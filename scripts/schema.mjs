import { writeFile } from "node:fs/promises";
import { z } from "zod";
import * as p from "../dist/protocol.js";
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
