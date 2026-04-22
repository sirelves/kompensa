/**
 * End-to-end example: order checkout with stock reservation, charge and invoice.
 *
 * Run:
 *   npx tsx examples/checkout.ts
 *
 * Demonstrates:
 *   - Typed context threading between steps
 *   - Retry with exponential backoff on transient errors
 *   - Compensation on downstream failure
 *   - Idempotency via idempotencyKey
 *   - Observability hooks
 */

import {
  createFlow,
  consoleLogger,
  MemoryStorage,
  TransientError,
  PermanentError,
  FlowError,
} from '../src/index.js';

// ---------- fake services ----------

const inventory = new Map<string, number>([['SKU-1', 10]]);
const charges = new Map<string, { amount: number; status: 'ok' | 'refunded' }>();
let chargeAttempts = 0;

async function reserveStock(sku: string, qty: number) {
  const stock = inventory.get(sku) ?? 0;
  if (stock < qty) throw new PermanentError(`out of stock: ${sku}`);
  inventory.set(sku, stock - qty);
  return { reservationId: `r_${Date.now()}`, sku, qty };
}

async function releaseStock(reservation: { sku: string; qty: number }) {
  inventory.set(reservation.sku, (inventory.get(reservation.sku) ?? 0) + reservation.qty);
}

async function chargeCard(orderId: string, amount: number) {
  chargeAttempts++;
  if (chargeAttempts < 2) {
    throw new TransientError('payment gateway 503');
  }
  const id = `ch_${orderId}`;
  charges.set(id, { amount, status: 'ok' });
  return { chargeId: id, amount };
}

async function refundCharge(chargeId: string) {
  const c = charges.get(chargeId);
  if (c) c.status = 'refunded';
}

async function issueInvoice(chargeId: string) {
  return { invoiceNumber: `INV-${chargeId}`, issuedAt: Date.now() };
}

// ---------- flow ----------

interface OrderInput {
  orderId: string;
  sku: string;
  qty: number;
  amount: number;
}

const checkout = createFlow<OrderInput>('checkout', {
  storage: new MemoryStorage(),
  logger: consoleLogger,
  defaultRetry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 50 },
  hooks: {
    onStepRetry: (e) =>
      console.log(`  ↻ retry ${e.stepName} attempt ${e.attempt} in ${Math.round(e.nextDelayMs)}ms`),
    onCompensate: (e) => console.log(`  ⊘ compensate ${e.stepName} → ${e.status}`),
  },
})
  .step('reserve', {
    run: (ctx) => reserveStock(ctx.input.sku, ctx.input.qty),
    compensate: (_ctx, reservation) => releaseStock(reservation),
  })
  .step('charge', {
    run: (ctx) => chargeCard(ctx.input.orderId, ctx.input.amount),
    compensate: (_ctx, charge) => refundCharge(charge.chargeId),
    timeout: 2_000,
  })
  .step('invoice', {
    run: (ctx) => issueInvoice(ctx.results.charge.chargeId),
  });

// ---------- scenarios ----------

async function happyPath() {
  console.log('\n=== happy path ===');
  const result = await checkout.execute(
    { orderId: '1001', sku: 'SKU-1', qty: 2, amount: 99 },
    { idempotencyKey: 'order-1001' },
  );
  console.log('result:', result);
}

async function idempotentReplay() {
  console.log('\n=== idempotent replay ===');
  const result = await checkout.execute(
    { orderId: '1001', sku: 'SKU-1', qty: 999, amount: 999 }, // different input — ignored
    { idempotencyKey: 'order-1001' },
  );
  console.log('replayed (cached):', result);
}

async function outOfStockCompensates() {
  console.log('\n=== out-of-stock (permanent) ===');
  try {
    await checkout.execute(
      { orderId: '2002', sku: 'SKU-1', qty: 99999, amount: 10 },
      { idempotencyKey: 'order-2002' },
    );
  } catch (err) {
    if (err instanceof FlowError) {
      console.log(`  failed at "${err.failedStep}":`, (err.originalError as Error).message);
      console.log('  compensations:', err.compensationErrors);
    }
  }
}

await happyPath();
await idempotentReplay();
await outOfStockCompensates();

console.log('\nfinal inventory:', Object.fromEntries(inventory));
console.log('charges:', Object.fromEntries(charges));
