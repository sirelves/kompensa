---
title: "4 bugs clássicos em sistemas multi-serviço no Node.js (e a lib que escrevi pra não reinventar a roda)"
published: false
description: "Duplicate charges, estoque fantasma, retry burro, crash no meio do fluxo. Quatro bugs que todo time encontra em produção. Escrevi uma lib pra resolver isso sem adotar Temporal."
tags: nodejs, typescript, backend, opensource
cover_image: https://raw.githubusercontent.com/sirelves/kompensa/main/.github/assets/social-preview.png
canonical_url: https://github.com/sirelves/kompensa
---

Toda vez que abro o incidente post-mortem de um time diferente, sempre tem pelo menos um desses quatro bugs.

Cliente cobrado duas vezes. Estoque travado porque o pagamento caiu. A gente marretou a API da Twilio em loop até tomar ban. Ou — o clássico das 3 da manhã — o pod crashou no meio do fluxo e a retentativa rodou tudo de novo, inclusive o passo que já tinha ido.

Sempre os mesmos quatro. E sempre alguém reinventando — mal — a roda pra resolver.

Esse é um post sobre esses quatro bugs, por que eles aparecem sempre, e a lib que escrevi pra parar de reinventá-los. Chama `kompensa`, tá no npm, TypeScript nativo, 20KB, zero dependência em runtime.

## Bug 1: o cliente foi cobrado duas vezes

O cenário mais caro. Seu endpoint de checkout começa a processar o pedido, o pagamento sai pro Stripe, mas antes da resposta voltar o cliente perdeu a conexão. O app mobile dele não sabe se deu certo, então retenta. A sua API recebe o POST de novo. E cobra de novo.

O que todo time faz num primeiro momento: cria uma tabela `processed_requests` com um hash do body como chave única, e verifica no começo do handler. Funciona — até alguém fazer um `UPDATE` na ordem do cliente sem reprocessar o pagamento e percebemos que a chave errada tava na tabela errada. Ou até alguém adicionar um campo de timestamp no request e cada retry virar uma "requisição nova".

O jeito certo é tornar a idempotência primeira-classe no seu fluxo: não uma tabela lateral, mas o identificador que dispara todo o comportamento.

No `kompensa` você passa uma `idempotencyKey` quando executa o flow. Na primeira vez, o flow roda de verdade. Na segunda com a mesma chave, ele devolve o resultado cacheado sem tocar em efeito colateral nenhum.

```ts
import { createFlow } from 'kompensa';

const checkout = createFlow<{ orderId: string }>('checkout')
  .step('charge', {
    run: async (ctx) => stripe.charge({
      amount: 9900,
      orderId: ctx.input.orderId,
    }),
  });

// Primeira chamada: Stripe é chamado.
const result1 = await checkout.execute(
  { orderId: 'ord_42' },
  { idempotencyKey: 'ord_42' },
);

// Segunda chamada com mesma chave: devolve result1, Stripe NÃO é chamado.
const result2 = await checkout.execute(
  { orderId: 'ord_42' },
  { idempotencyKey: 'ord_42' },
);
```

A regra é: a chave é um identificador de negócio que o cliente controla. O header `Idempotency-Key` do Stripe funciona. O `order_id` funciona. `Date.now()` NÃO funciona — porque cada retry gera uma chave nova e você volta à estaca zero.

## Bug 2: o estoque ficou travado porque o pagamento caiu

Esse é o segundo mais caro, mas o que mais incomoda no Slack do suporte.

O fluxo é: reservar estoque, cobrar cartão, emitir nota, enviar pra logística. Suponha que reserva deu certo, cobrança deu certo, mas a emissão de nota falhou porque o CNPJ do cliente voltou inválido do serviço da Receita.

O request quebra, você devolve 500. Mas o estoque tá reservado. E o cartão tá debitado.

Nos próximos 10 minutos você tem dois caminhos: ou o cliente reclama (e você descobre), ou ninguém reclama e aquele produto fica marcado como indisponível pra sempre. Dia normal, isso quebra uma Black Friday.

A solução pra esse tipo de fluxo é o padrão **Saga**. Cada passo tem um inverso semântico. Quando um passo falha, a gente caminha de trás pra frente executando os inversos dos passos que deram certo.

```ts
const checkout = createFlow<{ orderId: string }>('checkout')
  .step('reserveStock', {
    run: async (ctx) => inventory.reserve(ctx.input.orderId),
    compensate: async (_ctx, reservation) => inventory.release(reservation.id),
  })
  .step('charge', {
    run: async (ctx) => stripe.charge(ctx.input.orderId),
    compensate: async (_ctx, charge) => stripe.refund(charge.id),
  })
  .step('issueInvoice', {
    run: async (ctx) => taxService.issue(ctx.input.orderId),
    // sem compensate — emitir nota é o último passo, nada pra desfazer se falhar
  });
```

Se `issueInvoice` der erro: `stripe.refund` roda automaticamente, depois `inventory.release` roda automaticamente, e o `FlowError` que sai do `execute()` carrega o erro original + qualquer erro de compensação que aconteceu no caminho.

O importante: se a compensação ela mesma falhar (o refund não deu certo), esse erro é **coletado**, não mascarado. Você sabe tanto o que quebrou quanto o que não conseguiu ser desfeito — que é o pior caso, e precisa de alerta imediato pra um humano olhar.

## Bug 3: o retry burro que marretou a API externa até tomar ban

Esse é menos catastrófico mas acontece toda semana.

Alguém escreveu um `while (true) { try { ... } catch {} }` em volta duma chamada que às vezes falha. Ou colocou um retry no axios/fetch sem backoff. O que isso faz: numa falha transiente (503 do provider, timeout de rede, throttling de 429), você bombardeia o serviço externo em loop até dois segundos depois ter ou conseguido ou tomado um bloqueio no IP.

O retry certo tem três ingredientes:

1. **Backoff exponencial** — cada tentativa espera mais que a anterior
2. **Jitter** — um pouco de aleatoriedade pra evitar que todos os seus pods retentem ao mesmo tempo (thundering herd)
3. **Distinção entre transient e permanent** — erro 400 nunca vai funcionar, então não adianta retentar

```ts
import { createFlow, PermanentError, TransientError } from 'kompensa';

const flow = createFlow('payment').step('charge', {
  run: async (ctx) => {
    const res = await fetch('https://api.stripe.com/v1/charges', {
      method: 'POST',
      body: JSON.stringify(ctx.input),
      signal: ctx.signal,   // respeita timeout e cancelamento
    });

    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`stripe ${res.status}`);
    }
    if (!res.ok) {
      // 400, 401, 402, 404 — não adianta retentar
      throw new PermanentError(`stripe rejected: ${res.status}`);
    }
    return res.json();
  },
  retry: {
    maxAttempts: 5,
    backoff: 'exponential',
    initialDelayMs: 200,
    maxDelayMs: 10_000,
    jitter: true,
  },
  timeout: 10_000,
});
```

Com isso você espera 200ms, 400ms, 800ms, 1.6s, 3.2s entre tentativas (com jitter randomizando cada um). Se for 400 do Stripe, zero retry. Se for 503, retry com backoff até a quinta tentativa.

A diferença entre esse e `while(true) try catch` não é acadêmica: é a diferença entre "sua integração funciona sob pressão" e "seu IP foi banido pelo Stripe e você precisa abrir ticket com eles".

## Bug 4: o pod crashou no meio do fluxo e a retentativa rodou tudo de novo

Esse é o mais sutil e o mais fatal quando acontece.

A sua instância do serviço caiu depois de cobrar o cliente mas antes de criar o envio. A fila de jobs (BullMQ, SQS, o que for) re-entrega o job. O worker carrega o payload, corre o fluxo do começo — e cobra o cliente de novo.

Idempotência do bug 1 ajuda, mas só se você tiver idempotência **dentro** do fluxo. Se você tem os passos como try/catch manual, uma cobrança idempotente não te salva de cobrar o fornecedor da logística duas vezes.

A solução correta é **persistir o estado do fluxo a cada transição**, e na retentativa continuar do ponto onde parou. Cada passo bem-sucedido grava um registro. Se o processo morre, a próxima execução olha o registro e pula os passos já completados.

No kompensa isso é automático quando você conecta um adapter durável (Postgres ou Redis):

```ts
import { Pool } from 'pg';
import { createFlow } from 'kompensa';
import { PostgresStorage } from 'kompensa/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});
await storage.ensureSchema();  // cria a tabela flowguard_states

const checkout = createFlow<CheckoutInput>('checkout', { storage })
  .step('reserveStock', { run: reserveStock, compensate: releaseStock })
  .step('charge',       { run: charge,       compensate: refund       })
  .step('ship',         { run: ship                                    });

// Worker processando job
worker.process(async (job) => {
  return checkout.execute(job.data, {
    idempotencyKey: `order-${job.data.orderId}`,
  });
});
```

Se o worker crashar depois do `charge` mas antes do `ship`, o próximo consumer que pegar o mesmo job (com mesma idempotencyKey) carrega o estado persistido, vê que `charge` já foi `success`, e continua direto no `ship`. Nenhuma cobrança dupla, nenhuma reserva duplicada.

Além disso, o adapter do Postgres usa `pg_advisory_lock` na conexão — então mesmo se dois workers disputarem o mesmo job ao mesmo tempo, só um passa do ponto de carregar o estado. O outro espera ou falha rápido (configurável), dependendo da sua política.

## Um exemplo juntando tudo

O jeito mais honesto de mostrar isso é o checkout completo — reservar, cobrar, enviar nota. É isso:

```ts
import { Pool } from 'pg';
import { createFlow, FlowError, LockAcquisitionError } from 'kompensa';
import { PostgresStorage } from 'kompensa/storage/postgres';

const storage = new PostgresStorage({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
});
await storage.ensureSchema();

const checkout = createFlow<CheckoutInput>('checkout', {
  storage,
  lockWaitMs: 0,   // se outro worker tá processando essa chave, falha rápido
  defaultRetry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 200 },
})
  .step('reserveStock', {
    run:        (ctx) => inventory.reserve(ctx.input.items),
    compensate: (_ctx, res) => inventory.release(res.reservationId),
  })
  .step('charge', {
    run:        (ctx) => stripe.charge(ctx.input.userId, ctx.input.amount),
    compensate: (_ctx, c) => stripe.refund(c.id),
    timeout: 10_000,
  })
  .step('issueInvoice', {
    run: (ctx) => taxService.issue(ctx.input.orderId, ctx.results.charge.id),
  });

app.post('/checkout', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) return res.status(400).json({ error: 'missing key' });

  try {
    const result = await checkout.execute(req.body, { idempotencyKey });
    res.json(result);
  } catch (err) {
    if (err instanceof LockAcquisitionError) {
      return res.status(409).json({ error: 'in progress, retry shortly' });
    }
    if (err instanceof FlowError) {
      // Já compensou tudo. Cliente vê o erro de negócio.
      return res.status(422).json({
        error: err.message,
        failedAt: err.failedStep,
      });
    }
    throw err;
  }
});
```

Vinte linhas de endpoint, e você tem:

- Idempotência (cliente pode retentar à vontade)
- Backoff exponencial com jitter no pagamento
- Timeout por step
- Saga compensation no estoque e cartão
- Lock distribuído pra nunca ter dois workers na mesma chave
- Resume após crash
- Erros estruturados separando "outro worker está processando" de "o fluxo falhou e já foi desfeito"

Compare com a versão try/catch aninhada que normalmente sai disso. Não é a mesma linguagem.

## Quando NÃO usar

Pra ser honesto comigo e com você: o kompensa tem um escopo deliberadamente pequeno.

Se seu workflow dura dias, tem passos que esperam aprovação humana, precisa de replay histórico determinístico ou roda distribuído por uma frota de workers com coordenação entre si — você quer **Temporal** ou **AWS Step Functions**. Kompensa não substitui nenhum dos dois. Ele vive dentro do seu processo, o fluxo acontece em segundos ou minutos, e ele não tem história, não tem replay, não tem worker service separado.

É a camada de confiabilidade dentro do seu serviço, não um orquestrador externo.

Pra maior parte dos checkouts, onboardings, sincronizações de pedido e fluxos de pagamento que eu já vi, é isso que é preciso. O Temporal é overkill pra 90% dos casos.

## Tentando

```bash
npm install kompensa
```

O código tá aberto no GitHub, TypeScript completo, zero dependências em runtime, ESM + CJS. Tem 73 testes (50 unit + 23 de integração contra Postgres 17 e Redis 7 reais), incluindo simulação de crash via `pg_terminate_backend` pra provar que o lock libera quando o worker morre.

Feedback é bem-vindo — abri como MIT no [github.com/sirelves/kompensa](https://github.com/sirelves/kompensa).

Quem já perdeu uma madrugada resolvendo estoque travado vai entender.
