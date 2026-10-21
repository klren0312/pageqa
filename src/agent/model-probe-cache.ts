/**
 * 套件级模型探活缓存。
 *
 * 每个场景子进程原本各发一次模型 ping；多场景套件里这是 N 次重复的模型往返。
 * 父进程在派发前统一探一次，并在短 TTL 内复用结果。
 *
 * 只缓存**成功**：探活失败不写时间戳，下一次调用会重试。TTL 取短值（30s），
 * 这样模型中途挂掉时，最多一个 TTL 内的场景会跳过探活；它们的首次真实 LLM 调用
 * 仍会失败，只是不再由每个场景各自先付一次 ping。
 */
export function createProbeCache(
  probe: () => Promise<void>,
  opts: { ttlMs: number; now?: () => number },
): () => Promise<void> {
  const now = opts.now ?? Date.now;
  let lastOkAt: number | null = null;
  let inflight: Promise<void> | null = null;

  return async (): Promise<void> => {
    if (lastOkAt !== null && now() - lastOkAt < opts.ttlMs) return;
    if (!inflight) {
      inflight = probe()
        .then(() => {
          lastOkAt = now();
        })
        .finally(() => {
          inflight = null;
        });
    }
    await inflight;
  };
}
