import {readFile} from "node:fs/promises";
import https from "node:https";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

function argument(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const keyArgument = argument("key");
const certArgument = argument("cert");
const keyPath = keyArgument ? resolve(keyArgument) : "";
const certPath = certArgument ? resolve(certArgument) : "";
const port = Number(argument("port", "18443"));

if (!keyPath || !certPath || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Usage: node scripts/https-cors-fixture.mjs --key=PATH --cert=PATH [--port=18443]");
}

const [key, cert, originalLab, labCSS, labJS, frame, nativeDark] = await Promise.all([
  readFile(keyPath),
  readFile(certPath),
  readFile(join(projectRoot, "fixtures", "lab.html"), "utf8"),
  readFile(join(projectRoot, "fixtures", "lab.css")),
  readFile(join(projectRoot, "fixtures", "lab.js")),
  readFile(join(projectRoot, "fixtures", "frame.html")),
  readFile(join(projectRoot, "fixtures", "native-dark.html")),
]);

const lab = originalLab
  .replace(
    '<link rel="stylesheet" href="lab.css">',
    '<link rel="stylesheet" href="lab.css">\n    <link rel="stylesheet" href="https://cors.example/theme.css">\n    <link rel="stylesheet" href="https://nocors.example/theme.css">',
  )
  .replace(
    "</main>",
    '<section class="section"><article class="cors-card">CORS-authorized stylesheet</article><article class="nocors-card">CORS-denied stylesheet</article></section>\n    </main>',
  );

const server = https.createServer({key, cert}, (request, response) => {
  const hostname = String(request.headers.host || "").split(":")[0].toLowerCase();
  process.stdout.write(`${JSON.stringify({hostname, path: request.url, origin: request.headers.origin || "", mode: request.headers["sec-fetch-mode"] || ""})}\n`);

  response.setHeader("Cache-Control", "no-store");
  if ((hostname === "cors.example" || hostname === "nocors.example") && request.url === "/theme.css") {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/css; charset=utf-8");
    if (hostname === "cors.example") {
      response.setHeader("Access-Control-Allow-Origin", "https://page.example");
    }
    const selector = hostname === "cors.example" ? ".cors-card" : ".nocors-card";
    response.end(`${selector} { color: rgb(15, 20, 28); background: rgb(250, 250, 250); border: 2px solid rgb(40, 80, 180); padding: 1rem; }\n`);
    return;
  }

  if (hostname !== "page.example") {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  const routes = new Map([
    ["/", ["text/html; charset=utf-8", Buffer.from(lab)]],
    ["/lab.html", ["text/html; charset=utf-8", Buffer.from(lab)]],
    ["/lab.css", ["text/css; charset=utf-8", labCSS]],
    ["/lab.js", ["text/javascript; charset=utf-8", labJS]],
    ["/frame.html", ["text/html; charset=utf-8", frame]],
    ["/native-dark.html", ["text/html; charset=utf-8", nativeDark]],
  ]);
  const route = routes.get(request.url);
  if (!route) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", route[0]);
  response.end(route[1]);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Nightglass HTTPS CORS fixture listening on 127.0.0.1:${port}\n`);
});
