import type { FlowHooks, Logger } from '../types.js';

type HookName = keyof FlowHooks;

/**
 * Invoke a hook defensively: await it, catch any error, and log at warn level.
 * Hook failures must never affect the flow's outcome.
 */
export async function invokeHook<K extends HookName>(
  hooks: FlowHooks | undefined,
  name: K,
  event: Parameters<NonNullable<FlowHooks[K]>>[0],
  logger: Logger,
): Promise<void> {
  const fn = hooks?.[name] as
    | ((event: Parameters<NonNullable<FlowHooks[K]>>[0]) => void | Promise<void>)
    | undefined;
  if (!fn) return;
  try {
    await fn(event);
  } catch (err) {
    logger.warn(`hook ${String(name)} threw`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
