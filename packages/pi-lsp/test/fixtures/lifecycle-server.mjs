import { appendFileSync } from "node:fs";

const hang = process.argv[2];
const log = process.argv[3];
const record = (method) => appendFileSync(log, `${JSON.stringify({ method, pid: process.pid })}\n`);
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 20));
process.on("exit", () => record("exited"));
record("ready");
let buffer = Buffer.alloc(0);
function send(id, result) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function handle(message) {
  record(message.method);
  if (message.method === hang) return;
  if (message.method === "initialize") {
    send(message.id, { capabilities: { diagnosticProvider: {}, codeActionProvider: { resolveProvider: true } } });
  } else if (message.method === "textDocument/diagnostic") send(message.id, { items: [] });
  else if (message.method === "textDocument/codeAction") {
    send(message.id, [{ title: "fix", kind: "source.fixAll", data: { uri: message.params.textDocument.uri } }]);
  } else if (message.method === "codeAction/resolve") {
    send(message.id, {
      ...message.params,
      edit: {
        changes: {
          [message.params.data.uri]: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// fixed\n" },
          ],
        },
      },
    });
  } else if (message.method === "shutdown") send(message.id, null);
  else if (message.method === "exit") process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, separator).toString())?.[1]);
    const start = separator + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString());
    buffer = buffer.subarray(start + length);
    handle(message);
  }
});
