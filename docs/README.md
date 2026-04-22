# flowguard docs

- **[Getting started](./getting-started.md)** — install, first flow, execute
- **[Concepts](./concepts.md)** — steps, idempotency, retry, compensation, state machine
- **[Storage adapters](./storage-adapters.md)** — memory / Postgres / Redis / writing your own
- **[Recipes](./recipes/)** — real-world patterns
  - [Idempotent HTTP endpoint](./recipes/idempotent-endpoint.md)
  - [Mobile offline sync](./recipes/mobile-sync.md)
  - [Background worker (Bull/BullMQ)](./recipes/background-worker.md)
- **[API reference](./api.md)** — every exported function, class and type
- **[Testing your flows](./testing.md)** — in-process testing with MemoryStorage, integration with real adapters
- **[Operations](./operations.md)** — production checklist, observability, troubleshooting
