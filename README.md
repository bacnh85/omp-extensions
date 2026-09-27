# omp-extensions

OhMyPi (`omp`) extension packages. Maintained separately from
[`pi-extensions`](../pi-extensions): the omp extension/provider/usage APIs are
**not compatible** with pi's, and this repo avoids duplicating what omp already
provides natively (runtime provider registration with dynamic model discovery,
native usage-provider plumbing, `/login` flows).

| Package | Description |
|---------|-------------|
| **omp-router** | Connect omp to any OpenAI-compatible AI router (9router, OmniRoute, yardmaster, …) via its `/v1` API: `/router-url` stores the endpoint, models are discovered from `/v1/models`, and upstream-provider usage is surfaced through omp's native usage system. |

## Loading an extension

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/code/omp-extensions/omp-router
```

Or point at the package directory for a project (`<repo>/.omp/config.yml`),
or load ad hoc: `omp -e ~/code/omp-extensions/omp-router/extensions/index.ts`.

Packages declare entries under the `omp.extensions` manifest key.

## Development

```bash
npm install
npm run typecheck
npm test
```

Each package is self-contained (`omp-<name>/`) with its own `package.json`,
tsconfig, and `node:test` suite run through `tsx`.
