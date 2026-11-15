// One-time interactive login for a scripted test account:
//   npm run live:login -- member
//   npm run live:login -- admin
// Run it in your own terminal; the code and any password are typed there and
// are never stored. Only the resulting session is saved, under .data/live/.
import { createInterface } from "node:readline/promises";
import { Api } from "telegram";
import { createClient, roles, saveSession, type Role } from "./client.js";

const role = process.argv[2] as Role;
if (!roles.includes(role)) {
  console.error("Usage: npm run live:login -- <member|admin>");
  process.exit(2);
}
if (!process.stdin.isTTY) {
  console.error("Run this in an interactive terminal.");
  process.exit(2);
}

/** Where Telegram says it delivered the code. */
function delivery(type: Api.auth.TypeSentCodeType): string {
  if (type instanceof Api.auth.SentCodeTypeApp)
    return 'as a message in the "Telegram" service chat of an app where this account is already logged in (check the archive and other devices)';
  if (type instanceof Api.auth.SentCodeTypeSms) return "by SMS";
  if (type instanceof Api.auth.SentCodeTypeCall) return "by phone call";
  if (type instanceof Api.auth.SentCodeTypeEmailCode)
    return `by email to ${type.emailPattern}`;
  if (type instanceof Api.auth.SentCodeTypeFragmentSms)
    return "to the number's Fragment account";
  return `by ${type.className}, which this script cannot complete`;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = createClient(role);
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH!;
try {
  await client.connect();
  const phoneNumber = (
    await rl.question(
      `Phone number of the ${role} account (with +country code): `,
    )
  ).replace(/[\s()-]/g, "");
  let sent = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    }),
  );
  for (;;) {
    if (!(sent instanceof Api.auth.SentCode))
      throw new Error("Telegram did not ask for a code");
    console.log(`Telegram sent a login code ${delivery(sent.type)}.`);
    const phoneCode = (
      await rl.question(
        sent.nextType
          ? "Login code (or press Enter to have it sent another way): "
          : "Login code: ",
      )
    ).trim();
    const phoneCodeHash = sent.phoneCodeHash;
    if (!phoneCode && sent.nextType) {
      sent = await client.invoke(
        new Api.auth.ResendCode({ phoneNumber, phoneCodeHash }),
      );
      continue;
    }
    try {
      await client.invoke(
        new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode }),
      );
    } catch (e) {
      const message = (e as { errorMessage?: string }).errorMessage;
      if (message === "PHONE_CODE_INVALID") {
        console.log("That code was not accepted; try again.");
        continue;
      }
      if (message !== "SESSION_PASSWORD_NEEDED") throw e;
      await client.signInWithPassword(
        { apiId, apiHash },
        {
          password: () => rl.question("Two-step verification password: "),
          onError: (err) => {
            // Stop instead of asking again forever.
            throw err;
          },
        },
      );
    }
    break;
  }
  saveSession(role, client);
  const me = await client.getMe();
  console.log(
    `Logged in as ${me.firstName ?? ""} (id ${String(me.id)}) for the ${role} role.`,
  );
} catch (e) {
  console.error(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await client.destroy();
}
