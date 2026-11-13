import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostModules = new Set([
  "@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui",
  "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod",
]);

function importsOf(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      imports.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

describe("client bundle without development dependencies", () => {
  it("includes type-only imports and re-exports in the dependency check", () => {
    expect(importsOf("fixture.ts", `
      import type { Agent } from "@getpaseo/client";
      export type { Snapshot } from "private-sdk";
      type Model = import("model-sdk").Model;
      const load = () => import("runtime-sdk");
    `)).toEqual(["@getpaseo/client", "private-sdk", "model-sdk", "runtime-sdk"]);
  });

  it("reaches only host-provided external modules from the real client entry, including types", () => {
    const visited = new Set<string>();
    const unavailable: { file: string; module: string }[] = [];
    const walk = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const specifier of importsOf(file, readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) {
          if (!hostModules.has(specifier)) unavailable.push({ file: relative(root, file).replaceAll("\\", "/"), module: specifier });
          continue;
        }
        const base = resolve(dirname(file), specifier);
        const dependency = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
          .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
        expect(dependency, `${file}: cannot resolve ${specifier}`).toBeDefined();
        walk(dependency!);
      }
    };
    walk(join(root, "index.client.tsx"));
    expect(visited.has(join(root, "client", "pills.tsx"))).toBe(true);
    expect(unavailable).toEqual([]);
  });
});
