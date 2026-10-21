# Contributing

Use synthetic public fixtures only. Never copy private SaaS code, credentials, database schema, provider fixtures or business logic here. Read [development](docs/development.md), [security](docs/security.md) and [the protocol](docs/listener-protocol-v1.md).

Run `npm ci --ignore-scripts`, `npm test`, `npm run lint`, `npm run format:check` and `npm run pack:smoke`. Describe behavioral changes and relevant validation. Protocol edits require explicit compatibility/version review and updated schemas, fixtures, tests and handoff. No workflow should publish automatically; releases require owner approval.
