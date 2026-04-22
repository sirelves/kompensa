# flowguard

> Orquestração resiliente de operações para Node, browser e React Native.
> Sagas, idempotência, retry com backoff, compensação, timeout e storage plugável.
> Zero dependências em runtime.

```bash
npm install flowguard
```

---

## Por quê

Todo time acaba reinventando essas primitivas — mal. Quatro problemas caros que aparecem em qualquer sistema não-trivial:

- **Evitar duplicata** — como garantir que o cliente não foi cobrado duas vezes?
- **Retry seguro** — como repetir só em falha transitória, com backoff e sem marretar API externa?
- **Desfazer parcialmente** — o passo 3 falhou, e os passos 1 e 2 que já executaram?
- **Timeout em cadeia** — como cortar um step que pendurou sem travar o resto?

`flowguard` resolve os quatro em uma API pequena.

---

## Hello world

```ts
import { createFlow } from 'flowguard';

const checkout = createFlow<{ orderId: string }>('checkout')
  .step('reserveStock', {
    run: async (ctx) => reserveStock(ctx.input.orderId),
    compensate: async (_ctx, reservation) => releaseStock(reservation.id),
  })
  .step('charge', {
    run: async (ctx) => chargeCustomer(ctx.input.orderId, ctx.results.reserveStock.total),
    compensate: async (_ctx, charge) => refund(charge.id),
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 200 },
    timeout: 5_000,
  })
  .step('issueInvoice', {
    run: async (ctx) => issueInvoice(ctx.results.charge.id),
  });

const result = await checkout.execute(
  { orderId: '42' },
  { idempotencyKey: 'order-42' },
);
// → { reserveStock: {...}, charge: {...}, issueInvoice: {...} }
```

Se `charge` falhar, `reserveStock` é **compensado automaticamente** (ordem reversa). Se a mesma execução é disparada de novo com o mesmo `idempotencyKey`, o resultado volta do cache. Se o processo crashou no meio, a próxima execução **retoma do primeiro step incompleto**.

---

## Arquitetura

```
┌──────────────────────────────────────────────────┐
│                   Flow (builder)                  │
│     createFlow().step(...).step(...).execute()    │
└──────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│                    Executor                       │
│  idempotência · retry · timeout · compensação     │
│              máquina de estados persistida        │
└──────────────────────────────────────────────────┘
         │            │            │          │
         ▼            ▼            ▼          ▼
    ┌────────┐  ┌────────┐  ┌────────┐  ┌─────────┐
    │Storage │  │ Logger │  │ Hooks  │  │  Retry  │
    │  port  │  │  port  │  │  port  │  │ policy  │
    └────────┘  └────────┘  └────────┘  └─────────┘
```

**Princípios:**

- **Hexagonal.** Core puro; storage, logger, hooks e retry são portas plugáveis.
- **Zero deps.** Nada no core. Adaptadores pesados (Postgres/Redis) ficam em pacotes separados.
- **Isomórfico.** Funciona em Node 18+, browsers modernos e React Native (Hermes). Sem APIs Node-only.
- **Type-safe.** Resultados dos steps se acumulam no tipo — cada step enxerga os anteriores.
- **Persistente por padrão.** Todo estado de transição é salvo; crash ≠ perda de progresso.

---

## API

### `createFlow<TInput>(name, config?)`

Cria um novo flow.

```ts
createFlow<{ userId: string }>('signup', {
  storage: new MemoryStorage(),   // default
  logger: consoleLogger,          // default: silentLogger
  hooks: { onStepEnd: (e) => metrics.record(e) },
  defaultRetry: { maxAttempts: 3 },
  defaultTimeout: 10_000,
});
```

### `.step(name, definition)`

Adiciona um step. O tipo do resultado é acumulado — `ctx.results.previousStep` é tipado.

```ts
.step('fetchUser', {
  run: async (ctx) => db.users.find(ctx.input.userId),      // → typed in next step as ctx.results.fetchUser
  compensate: async (ctx, user) => auditLog('rolled back', user.id),
  retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 100, jitter: true },
  timeout: 5_000,
  skipIf: (ctx) => ctx.metadata.dryRun === true,
})
```

### `.execute(input, options?)`

```ts
await flow.execute(input, {
  idempotencyKey: 'order-42',    // same key → cached result / resume
  signal: controller.signal,     // AbortController support
  metadata: { tenantId: 'x' },   // free-form, available to steps & hooks
  timeout: 30_000,               // default step timeout
});
```

---

## Retry policy

```ts
{
  maxAttempts: 3,                // total, including the first try
  backoff: 'exponential',        // 'fixed' | 'linear' | 'exponential'
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  multiplier: 2,                 // for exponential
  jitter: true,                  // bool or fraction 0..1
  shouldRetry: (err, attempt) => err.code !== 'E_NOT_ALLOWED',
}
```

Erros retornados como `PermanentError` **nunca** são re-tentados. `TransientError` e `StepTimeoutError` são elegíveis por padrão.

```ts
import { PermanentError, TransientError } from 'flowguard';

throw new PermanentError('validation failed');   // dead-stop
throw new TransientError('429 rate limited');    // eligible for retry
```

---

## Compensação (padrão Saga)

Quando um step falha, os steps anteriores com função `compensate` são executados em **ordem reversa**. Erros na compensação são coletados — nunca mascaram o erro original:

```ts
try {
  await checkout.execute(input);
} catch (err) {
  if (err instanceof FlowError) {
    err.failedStep;            // 'charge'
    err.originalError;         // Error: card declined
    err.compensationErrors;    // [{ step: 'reserveStock', error: ... }]
  }
}
```

---

## Idempotência e resume

O `idempotencyKey` é a chave do estado persistido. Três cenários:

| Estado anterior  | Comportamento                                             |
| ---------------- | --------------------------------------------------------- |
| `success`        | Retorna o resultado cacheado sem re-executar              |
| `compensated`    | Re-lança o `FlowError` original                           |
| `running` (crash)| Retoma a partir do primeiro step com status `!= success`  |
| _(não existe)_   | Executa normalmente                                       |

---

## Cancelamento

Use `AbortSignal` para interromper o flow. O cancelamento é respeitado:
- Entre steps (ao começar o próximo)
- Durante delays de retry
- Opcionalmente, dentro do step (o signal está em `ctx.signal`)

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

await flow.execute(input, { signal: controller.signal });
```

---

## Observabilidade

Todos os hooks são opcionais e assíncronos. Falhas no hook nunca afetam o flow:

```ts
createFlow('checkout', {
  hooks: {
    onFlowStart:  (e) => tracer.startSpan(e.flowName, e.flowId),
    onStepStart:  (e) => logger.info({ step: e.stepName, attempt: e.attempt }),
    onStepRetry:  (e) => metrics.inc('retry', { step: e.stepName }),
    onStepEnd:    (e) => metrics.timing('step.duration', e.durationMs),
    onCompensate: (e) => logger.warn({ compensate: e.stepName, status: e.status }),
    onFlowEnd:    (e) => tracer.endSpan(e.flowId, e.status),
  },
});
```

---

## Storage adapters

O core inclui `MemoryStorage` — suficiente para testes, filas in-memory e apps mobile/browser.

```ts
import { MemoryStorage } from 'flowguard/storage/memory';
// ou: import { MemoryStorage } from 'flowguard';
```

Implementar um adaptador é trivial:

```ts
import type { StorageAdapter, FlowState } from 'flowguard';

class PostgresStorage implements StorageAdapter {
  async load(flowName: string, flowId: string): Promise<FlowState | null> { /* ... */ }
  async save(state: FlowState): Promise<void> { /* UPSERT ... */ }
  async delete(flowName: string, flowId: string): Promise<void> { /* ... */ }
}
```

Adaptadores Postgres e Redis ficam em pacotes separados (`flowguard-postgres`, `flowguard-redis`) a partir de v0.2.

---

## Web / mobile (React, React Native)

O core é isomórfico. Você pode usar do mesmo jeito em front, back ou RN:

```tsx
// React — sincronizando pedido offline quando volta a rede
import { createFlow, MemoryStorage } from 'flowguard';

const syncOrder = createFlow<{ orderId: string }>('sync-order', {
  storage: new MemoryStorage(),
})
  .step('upload', {
    run: async (ctx) => api.post('/orders', ctx.input),
    retry: { maxAttempts: 5, backoff: 'exponential', initialDelayMs: 500 },
  })
  .step('markSynced', {
    run: async (ctx) => localDb.mark(ctx.input.orderId, 'synced'),
  });

export function useSyncOrder() {
  return useCallback(
    (orderId: string) =>
      syncOrder.execute({ orderId }, { idempotencyKey: `sync-${orderId}` }),
    [],
  );
}
```

Para persistência no mobile, passe um `StorageAdapter` que grave em SQLite/AsyncStorage/MMKV — a interface tem só `load`, `save` e `delete`.

---

## Decisões de design

- **TypeScript 5, target ES2020.** Roda em Node 18+, browsers evergreen e Hermes.
- **Build dual** (ESM + CJS) com tsup, tipos gerados via `tsc`.
- **Zero runtime deps** — o core não importa nada.
- **API fluente com type-accumulation** — `.step('a', ...).step('b', { run: ctx => ctx.results.a.x })` é estaticamente verificado.
- **Hexagonal** — core domain + ports. Adaptadores podem ser trocados sem mexer no core.
- **Estado como fonte da verdade** — qualquer retomada é reconstruída do storage.
- **Falha no hook é warn, não fatal** — observabilidade não pode derrubar o flow.

---

## Licença

MIT
