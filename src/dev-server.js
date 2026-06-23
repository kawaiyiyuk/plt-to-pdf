import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { convertPltBufferWithHp2xx } from "./server/hp2xx-converter.js";
import { ConversionQueue, QueueFullError } from "./server/conversion-queue.js";
import { UploadTooLargeError } from "./server/http-errors.js";

const root = resolve(".");
const port = Number(process.env.PORT ?? 4173);
const host = "127.0.0.1";
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? 20);
const maxUploadBytes = Math.max(1, maxUploadMb) * 1024 * 1024;
const maxJsonUploadBytes = getMaxJsonUploadBytes(maxUploadBytes);
const convertTimeoutMs = Number(process.env.CONVERT_TIMEOUT_MS ?? 30000);
const convertQueue = new ConversionQueue({
  concurrency: Number(process.env.CONVERT_CONCURRENCY ?? 1),
  queueLimit: Number(process.env.CONVERT_QUEUE_LIMIT ?? 20)
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/convert") {
      await handleConvert(req, res);
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = resolve(join(root, pathname.slice(1)));
    if (!isPathInsideRoot(filePath)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } else {
      res.end();
    }
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  server.listen(port, host, () => {
    console.log(`http://${host}:${port}`);
  });
}

async function handleConvert(req, res) {
  try {
    const body = await readRequestBody(req, maxJsonUploadBytes);
    const payload = JSON.parse(body.toString("utf8"));
    const source = payload.sourceBase64
      ? Buffer.from(payload.sourceBase64, "base64")
      : Buffer.from(payload.source ?? "", "utf8");
    if (source.byteLength > maxUploadBytes) {
      throw new UploadTooLargeError(maxUploadMb);
    }
    const { pdf, svg, layout } = await convertQueue.run(() => convertPltBufferWithHp2xx(source, {
      paperSize: payload.paperSize || null,
      orientation: payload.orientation || "auto",
      marginPt: Number(payload.marginPt ?? 0),
      lineWidthMm: Number(payload.lineWidthMm),
      unitsPerInch: Number(payload.unitsPerInch ?? 1016),
      timeoutMs: convertTimeoutMs
    }));
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify({
      pdfBase64: Buffer.from(pdf, "utf8").toString("base64"),
      svgBase64: Buffer.from(svg, "utf8").toString("base64"),
      layout
    }));
  } catch (error) {
    const statusCode = getErrorStatusCode(error);
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        chunks.length = 0;
        if (!rejected) {
          rejected = true;
          reject(new UploadTooLargeError(maxUploadMb));
        }
        return;
      }
      if (!rejected) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (!rejected) {
        resolvePromise(Buffer.concat(chunks));
      }
    });
    req.on("error", (error) => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

function getErrorStatusCode(error) {
  if (error instanceof QueueFullError) {
    return error.statusCode;
  }
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }
  return 500;
}

export function getMaxJsonUploadBytes(maxDecodedBytes) {
  return Math.ceil(maxDecodedBytes * 4 / 3) + 1024;
}

function isPathInsideRoot(filePath) {
  const relativePath = relative(root, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
