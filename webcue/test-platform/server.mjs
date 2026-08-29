// Serves the engine self-test and collects the results browsers POST back.
//
// It runs on the Mac and reaches each VM through an SSH REVERSE TUNNEL
// (ssh -R 8123:127.0.0.1:8123 <vm>). That detail is load-bearing rather than
// convenient: AudioWorklet needs a secure context, and a plain-http origin on
// another machine is not one — but http://localhost IS, and a reverse tunnel
// makes this server look exactly like localhost to the guest. It also means no
// server, no node and no copy of the build has to be installed in any VM.
//
// Results accumulate so several machines can report into one run.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8123);
const collected = [];

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    const body = JSON.parse(Buffer.concat(chunks).toString());

    console.log('\n===== SELF-TEST RESULT =====');
    console.log(body.ua);
    for (const r of body.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  - ' + r.detail : ''}`);
    }
    console.log(`----- ${body.failed} failed of ${body.total} -----`);

    collected.push({ at: new Date().toISOString(), ...body });
    await writeFile(join(root, 'results.json'), JSON.stringify(collected, null, 2));

    res.writeHead(204).end();
    return;
  }

  const path = (req.url ?? '/').split('?')[0];
  console.log(`${req.method} ${path}`);

  const name = path === '/' ? '/selftest.html' : path;
  const file = join(root, normalize(name).replace(/^(\.\.[/\\])+/, ''));

  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}/`);
});
