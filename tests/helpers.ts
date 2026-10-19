import { after } from "node:test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { makeFetchResult as rawMakeFetchResult, makeSearchResult as rawMakeSearchResult } from "../src/output.ts";

const directories = new Set<string>();
function pathsInText(result: { content?: unknown }, pattern: RegExp): string[] {
  const paths: string[] = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      for (const match of part.text.matchAll(pattern)) paths.push(match[1]);
    }
  }
  return paths;
}

/** Test-only cleanup discovery; production details do not carry file paths. */
export function searchBodyPaths(result: { content?: unknown }): string[] {
  return pathsInText(result, /^Page content file: (.+)\. Use the read tool to inspect it\.$/gm);
}
export function fetchBodyPaths(result: { content?: unknown }): string[] {
  return pathsInText(result, /^\[Content truncated\. Complete page content saved as Markdown: (.+)\. Use the read tool to inspect it\.\]$/gm);
}
export function trackResult<T extends { content?: unknown }>(result: T): T {
  for (const path of [...searchBodyPaths(result), ...fetchBodyPaths(result)]) directories.add(dirname(path));
  return result;
}

export const makeFetchResult: typeof rawMakeFetchResult = async (...args) => trackResult(await rawMakeFetchResult(...args));
export const makeSearchResult: typeof rawMakeSearchResult = async (...args) => trackResult(await rawMakeSearchResult(...args));

after(async () => {
  await Promise.all([...directories].map(path => rm(path, { recursive: true, force: true })));
});
