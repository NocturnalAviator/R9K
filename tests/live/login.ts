// One-time interactive login for a scripted test account:
//   npm run live:login -- member
//   npm run live:login -- admin
// Run it in your own terminal; the code and any password are typed there and
// are never stored. Only the resulting session is saved, under .data/live/.
import { createInterface } from "node:readline/promises";
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

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = createClient(role);
try {
  await client.start({
    phoneNumber: () =>
      rl.question(`Phone number of the ${role} account (with +country code): `),
    phoneCode: () => rl.question("Login code Telegram just sent: "),
    password: () => rl.question("Two-step verification password: "),
    onError: (e) => {
      // Stop instead of asking again forever.
      throw e;
    },
  });
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
