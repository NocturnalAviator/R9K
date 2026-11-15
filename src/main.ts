import { pino } from "pino";
import { run } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { readConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { sweepExpiredText } from "./db/retention.js";
import { createBot } from "./bot.js";
import { errorSummary } from "./errors.js";
const config = readConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = openDb(config);
try {
  await migrate(db);
  await sweepExpiredText(db, new Date());
  let retention: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (retention) return;
    retention = sweepExpiredText(db, new Date())
      .catch((e: unknown) => {
        logger.error({ err: errorSummary(e) }, "Text cleanup failed");
      })
      .finally(() => {
        retention = undefined;
      });
  }, 60000);
  timer.unref();
  const bot = createBot({ db, config, logger, clock: () => new Date() });
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  const runner = run(bot, {
    runner: {
      silent: true,
      fetch: {
        allowed_updates: [
          "message",
          "edited_message",
          "my_chat_member",
          "chat_member",
          "callback_query",
        ],
      },
    },
  });
  logger.info(
    { database: config.DATABASE_URL ? "postgres" : "pglite" },
    "Bot polling",
  );
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(timer);
      await runner.stop();
      await retention;
      await db.close();
    })();
    return stopping;
  };
  const onSignal = () => {
    void stop().catch(() => logger.error("Shutdown failed"));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await runner.task();
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
} catch (e) {
  logger.error({ err: errorSummary(e) }, "Bot startup or polling failed");
  await db.close();
  process.exitCode = 1;
}
