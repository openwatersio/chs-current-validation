import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The specifiers a module loads when it runs. Type stripping erases `import type` and `export type` statements, so they load nothing. */
function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  // `[^;]` keeps a match inside one statement.
  const statement = /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of source.matchAll(statement)) if (!m[1]) out.push(m[2]);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

/** Every package specifier, other than a `node:` built-in, in the local import graph of `entry`, as `<file>: <specifier>`. */
async function packageImports(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeSpecifiers(await readFile(file, "utf8"))) {
      if (spec.startsWith(".")) await visit(resolve(dirname(file), spec));
      else if (!spec.startsWith("node:")) found.push(`${relative(ROOT, file)}: ${spec}`);
    }
  };
  await visit(resolve(ROOT, entry));
  return found;
}

// The publish job holds the write tokens and installs no packages, so its scripts must need none.
test.each(["scripts/target.ts", "scripts/announce.ts"])(
  "%s, which the publish job runs, loads no package code",
  async (script) => {
    expect(await packageImports(script)).toEqual([]);
  },
);

test("the import walk finds a package behind local imports and skips type-only ones", async () => {
  expect(await packageImports("scripts/record.ts")).toContain("src/curated.ts: yaml");
  expect(
    runtimeSpecifiers(
      [
        'import type { A } from "./a.ts";',
        'import { type B, c } from "./b.ts";',
        "import {\n  d,\n  e,\n} from 'pkg';",
        'export { f } from "./f.ts";',
        'export type { G } from "./g.ts";',
        'import "./side.ts";',
        "export const h = 1;",
        'const i = "x from \\"y\\"";',
        'await import("./lazy.ts");',
      ].join("\n"),
    ),
  ).toEqual(["./b.ts", "pkg", "./f.ts", "./side.ts", "./lazy.ts"]);
});
