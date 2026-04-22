# Recipe: mobile offline sync

User creates an order while offline. When connectivity returns (or the app relaunches), the pending work syncs reliably — even if the phone goes into the background mid-sync.

## Complete example (React Native + Expo SQLite)

```ts
import * as SQLite from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';
import { createFlow, TransientError, FlowError } from 'sagaflow';
import { SqliteStorage } from './SqliteStorage'; // see docs/storage-adapters.md

const db = await SQLite.openDatabaseAsync('sagaflow.db');
const storage = new SqliteStorage(db);

const syncOrder = createFlow<{ orderId: string; payload: OrderPayload }>('sync-order', {
  storage,
})
  .step('upload', {
    run: async (ctx) => {
      const res = await fetch('https://api.example.com/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': ctx.input.orderId, 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx.input.payload),
        signal: ctx.signal,
      });
      if (res.status >= 500 || res.status === 429) {
        throw new TransientError(`upload failed: ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`upload rejected: ${res.status}`);
      }
      return res.json() as Promise<{ remoteId: string }>;
    },
    retry: { maxAttempts: 5, backoff: 'exponential', initialDelayMs: 1000 },
    timeout: 15_000,
  })
  .step('markSynced', {
    run: async (ctx) => {
      await db.runAsync(
        'UPDATE orders SET synced_at = ?, remote_id = ? WHERE id = ?',
        [Date.now(), ctx.results.upload.remoteId, ctx.input.orderId],
      );
      return { syncedAt: Date.now() };
    },
  });

// Fire a sync attempt whenever network is available.
NetInfo.addEventListener(async (state) => {
  if (!state.isConnected) return;
  const pending = await db.getAllAsync<{ id: string; payload: string }>(
    'SELECT id, payload FROM orders WHERE synced_at IS NULL',
  );
  for (const order of pending) {
    syncOrder
      .execute(
        { orderId: order.id, payload: JSON.parse(order.payload) },
        { idempotencyKey: `sync-${order.id}` },
      )
      .catch((err) => {
        if (err instanceof FlowError) {
          // Non-retryable failure — server said no. Mark locally, user sees error.
          db.runAsync('UPDATE orders SET sync_error = ? WHERE id = ?', [err.message, order.id]);
        }
      });
  }
});
```

## Why this works end-to-end

| Event | What sagaflow does |
| --- | --- |
| Network comes back mid-upload | Retry with exponential backoff, up to 5 attempts |
| App backgrounded during retry delay | `setTimeout` gets throttled but nothing is lost; next resume continues the retry |
| App force-closed between `upload` and `markSynced` | Next launch resumes from `markSynced` — no duplicate server order |
| Server 4xx (bad data) | Non-retryable; `FlowError` thrown, error recorded locally for user |
| Server 5xx | `TransientError` → retry |
| Server 429 | `TransientError` → retry with backoff |

## Why `SqliteStorage` (not `MemoryStorage`)

`MemoryStorage` is wiped when the process exits. On mobile, the OS can kill your app at any time — if a sync was in progress, `MemoryStorage` forgets it and the user's order sits in "pending" forever.

`SqliteStorage` persists flow state next to your app data. The next app launch picks up right where it left off.

See [storage-adapters.md](../storage-adapters.md#minimal-sqlite-adapter-for-mobile) for a 30-line SqliteStorage implementation.
