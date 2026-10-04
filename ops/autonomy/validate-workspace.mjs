import { spawnSync } from "node:child_process";

const commands = [
  ["npm", ["ci"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "build"]],
  ["npm", ["audit", "--omit=dev", "--audit-level=high"]],
];

for (const [command, args] of commands) {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit", shell: false, timeout: 10 * 60 * 1000 });
  if (result.error) {
    process.stderr.write(`${command} failed to run: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
