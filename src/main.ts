import { pino } from "pino";
import { run } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { readConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { sweepExpiredText } from "./db/retention.js";
import { createBot } from "./bot.js";
import { errorSummary } from "./errors.js";
import { registerCommands } from "./commands.js";
import { Health } from "./operations/health.js";
import { Alerts } from "./operations/alerts.js";
import { postWeekly } from "./stats/scores.js";
const config = readConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = openDb(config);
const health = new Health(() => new Date());
const alerts = new Alerts(
  () => new Date(),
  async (text) => {
    if (config.ALERT_CHAT_ID !== undefined)
      await bot.api.sendMessage(config.ALERT_CHAT_ID, text);
  },
);
const bot = createBot({
  db,
  config,
  logger,
  clock: () => new Date(),
  health,
  alerts,
});
const server = config.HEALTH_PORT
  ? health.listen(db, config.HEALTH_PORT)
  : undefined;
try {
  await migrate(db);
  await sweepExpiredText(db, new Date());
  let retention: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (retention) return;
    retention = (async () => {
      await sweepExpiredText(db, new Date());
      await postWeekly(db, new Date(), (id, text) =>
        bot.api.sendMessage(id, text),
      );
    })()
      .catch(async (e: unknown) => {
        await alerts.report(e);
        logger.error({ err: errorSummary(e) }, "Text cleanup failed");
      })
      .finally(() => {
        retention = undefined;
      });
  }, 600000);
  timer.unref();
  // No client-side throttler: it spaces every call that carries a chat_id one
  // second apart (deletes and lookups included). auto-retry handles 429s.
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
  // The "/" menu in Telegram clients; the bot works without it.
  registerCommands(bot.api).catch((e: unknown) => {
    logger.warn({ err: errorSummary(e) }, "Command list registration failed");
  });
  logger.info(
    { database: config.DATABASE_URL ? "postgres" : "pglite" },
    "Bot polling",
  );
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(timer);
      server?.close();
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
  server?.close();
  await alerts.report(e);
  logger.error({ err: errorSummary(e) }, "Bot startup or polling failed");
  await db.close();
  process.exitCode = 1;
}
