import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "dist", "macpurge");
await mkdir(resolve(root, "dist"), { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(root, "src", "cli.ts")],
  compile: {
    target: "bun-darwin-arm64",
    outfile: output,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Bun's linker signature can be invalidated while embedding the payload on newer
// macOS versions. Re-apply a local ad-hoc signature before smoke testing/install.
const sign = Bun.spawn({
  cmd: ["/usr/bin/codesign", "--force", "--sign", "-", output],
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await sign.exited) !== 0) process.exit(1);

console.log(`Built and ad-hoc signed ${output}`);
