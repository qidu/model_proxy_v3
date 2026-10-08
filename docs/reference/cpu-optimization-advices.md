# CPU Optimization: Format-Transforming Converters

This document summarizes practical ways to reduce the CPU load of the format-transforming converters (`claude‑to‑openai.ts`, `openai‑to‑claude.ts`, `claude‑to‑gemini.ts`, etc.), which are typically the hottest CPU path in the proxy.

## Quick Wins (apply today)

1. **Avoid full JSON.parse / stringify when not needed**
   - Parse only the fields you actually need (e.g., `model`, `stream`, `messages`).
   - For streaming bodies, keep the raw chunk and splice/replace only the necessary substrings instead of re-serializing the whole object.
   - JSON.parse/stringify are O(n) and allocate temporary objects. Working on a subset or on raw text cuts both allocation and CPU time.

2. **Use a faster JSON library**
   - Replace built-in `JSON.parse`/`stringify` with SIMD-accelerated parsers like [`fast-json-parse`](https://www.npmjs.com/package/fast-json-parse) or [`fast-safe-stringify`](https://www.npmjs.com/package/fast-safe-stringify).
   - These libraries use typed arrays and can be 2–3× faster than V8 built-ins for large payloads.

3. **Use TransformStream with chunk-level operations**
   - Keep a `TransformStream` that works on each `Uint8Array` chunk instead of buffering the whole body.
   - Inside the `transform` method, scan the chunk for known patterns (e.g., `"model":"`) and replace them in-place.
   - This avoids allocating intermediate strings/objects per chunk and keeps memory bandwidth low.

4. **Cache small, static transformations**
   - If the same model alias mapping is used repeatedly (e.g., always mapping `my-model` → `gpt-4`), keep a small LRU cache of the transformed template strings.
   - This eliminates redundant string concatenation / template work for the hot path.

5. **Profile and micro-optimize hot spots**
   - Run the process with `node --prof` or Chrome DevTools → Performance tab while sending representative traffic.
   - Look for the biggest self-time in the converter functions (e.g., `JSON.parse`, `String.replace`, recursive object walks).
   - Apply targeted fixes: replace heavy regex with `indexOf`/`slice`, avoid creating temporary arrays, use `for` loops instead of `forEach`.

## Medium investment

6. **Reduce the frequency of transformation**
   - If a particular upstream already speaks the same protocol as the client, skip the converter entirely for that route.
   - Detect this via `upstreamMode` and bypass the TransformStream.
   - (Partially done already — the `if (attemptUpstreamMode === …)` branches can be extended.)

## Larger investments

7. **Leverage native JSON via WebAssembly / Rust**
   - Compile a small Rust crate that exposes JSON parsing and transformation functions to WASM (using `wasm-pack` or `rollup-plugin-wasm`).
   - WASM modules execute straight machine code. Number-crushing and buffer-manipulation (scanning for keys, splice/replace) run at near-native speed.
   - Data can be passed via `SharedArrayBuffer` or by copying a `Uint8Array`, keeping allocation low.

   Example Rust snippet:
   ```rust
   #[wasm_bindgen]
   pub fn transform_claude_to_openai(input: &[u8]) -> Vec<u8> {
       let mut s = String::from_utf8_lossy(input).to_string();
       // simple replace: `"model":"..."` → `"model":"gpt-4"`
       s = s.replace(r#""model":"#", r#""model":"gpt-4""#);
       // more transforms...
       s.into_bytes()
   }
   ```

8. **Off-load to a Worker thread**
   - Move heavy conversion logic to a `Worker` (or `SharedWorker`) and `postMessage` the raw chunk, receive the transformed chunk back.
   - This keeps the main event loop free for handling I/O and other requests by using another CPU core.

   Example:
   ```ts
   // index.ts
   const worker = new Worker(new URL('./converter-worker.ts', import.meta.url), { type: 'module' });
   worker.postMessage({ chunk, type: 'claude-to-openai' });
   worker.onmessage = e => { /* use e.data.chunk */ };

   // converter-worker.ts
   self.onmessage = e => {
     const chunk = e.data.chunk;
     const transformed = doTransform(chunk, e.data.type);
     self.postMessage({ chunk: transformed });
   };
   ```

## Notes

- **Statistics modules** (`Model Statistic`, `Request Statistic`, `Agent Statistic`) consume virtually no CPU — they are just lightweight `Map` counters and are not worth optimizing.
- The **real levers are in the converters**: optimizing how they parse, manipulate, and re-serialize JSON (or avoiding those steps altogether) gives the biggest wins.
- Start with the lightweight swaps (faster JSON libs, targeted string splices) and only reach for WASM/Workers if you still need to shave off tens of milliseconds per request on high-traffic endpoints.