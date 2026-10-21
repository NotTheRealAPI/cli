export type Fields = Record<string, string | number | boolean | null>;
export type Reporter = (state: string, fields?: Fields) => void;
export function reporter(
  json: boolean,
  write = (line: string) => process.stdout.write(line),
): Reporter {
  // Only explicitly selected, validated fields enter this reporter. Never pass exceptions/URLs/headers.
  return (state, fields = {}) =>
    write(
      json
        ? `${JSON.stringify({ version: 1, state, ...fields })}\n`
        : `${state}${Object.entries(fields)
            .map(([k, v]) => ` ${k}=${v}`)
            .join("")}\n`,
    );
}
