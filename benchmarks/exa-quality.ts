import { mkdirSync, writeFileSync } from "node:fs";
import { searchWithExa } from "../exa.ts";

const queries = [
 "Cloudflare Workers Durable Objects SQLite storage",
 "TypeScript satisfies operator documentation",
 "React useEffect cleanup StrictMode documentation",
 "Svelte 5 runes derived state documentation",
 "Node.js AbortSignal any timeout documentation",
 "Python asyncio TaskGroup exception handling",
 "PostgreSQL SELECT FOR UPDATE SKIP LOCKED",
 "SQLite WAL mode concurrent readers writers",
 "Cloudflare Agents SDK callable RPC",
 "React server components security",
];
const objective = "Find canonical, current English documentation and primary sources. Prefer the maintained API reference over mirrors and old tutorials. Extract the relevant API behavior, caveats and practical code examples.";
const records: unknown[] = [];
const directory = new URL("./exa-quality/", import.meta.url);
mkdirSync(directory, { recursive: true });
const save = () => writeFileSync(new URL("results.json", directory), JSON.stringify({ date: new Date().toISOString(), objective, records }, null, 2));
for (const query of ["Cloudflare Workers pricing", "TypeScript satisfies operator documentation"]) {
 const result = await searchWithExa(query, { objective, maxAgeHours: 24, numResults: 5 });
 records.push({ phase: "smoke", ...result }); save();
 console.log(`Smoke: ${query}: ${result.results.length} results`);
}
for (let index = 0; index < queries.length; index++) {
 const variants = ["baseline", "bounded", "dynamic"] as const;
 // Rotate order; compare the old request body against two upgraded configurations.
 for (let offset = 0; offset < 3; offset++) {
  const variant = variants[(index + offset) % 3];
  const start = performance.now();
  try {
   const result = await searchWithExa(queries[index], {
    numResults: 5,
    ...(variant === "baseline" ? {} : { objective, highlightMode: variant, ...(variant === "bounded" ? { highlightMaxCharacters: 2000 } : {}) }),
   });
   records.push({ phase: "benchmark", index, variant, ms: Math.round(performance.now() - start), chars: result.results.reduce((sum, r) => sum + r.text.length, 0), ...result });
   console.log(`${index + 1}/10 ${variant}: ${result.results.length} results, ${Math.round(performance.now() - start)}ms`);
  } catch (e) {
   records.push({ phase: "benchmark", index, variant, error: e instanceof Error ? e.message : String(e) });
   console.log(`${index + 1}/10 ${variant}: failed`);
  }
  save();
 }
}
