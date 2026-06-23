import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertDrawingToPdf, convertPltFile, convertPltToPdf, getTiledPdfLayout, parseHpgl } from "../src/plt-to-pdf.js";
import { convertPltBufferWithHp2xx } from "../src/server/hp2xx-converter.js";
import { buildPdfFromSvg, getSvgPdfLayout } from "../src/server/svg-to-pdf.js";
import { ConversionQueue, QueueFullError } from "../src/server/conversion-queue.js";
import { ConversionTimeoutError } from "../src/server/http-errors.js";
import { decodePltBuffer } from "../src/core/text-decoding.js";
import { sanitizeSvgInnerMarkup } from "../src/core/svg-sanitize.js";
import { getMaxJsonUploadBytes } from "../src/dev-server.js";

test("parses line work and text", () => {
  const drawing = parseHpgl("IN;SP1;PW20;PA;PU0,0;PD100,0,100,100,0,100,0,0;PU50,50;LBHello\x03;");
  assert.equal(drawing.shapes.length, 2);
  assert.equal(drawing.shapes[0].id, "shape-1");
  assert.equal(drawing.shapes[0].type, "path");
  assert.equal(drawing.shapes[0].lineWidthUnits, 20);
  assert.equal(drawing.shapes[1].type, "text");
  assert.equal(drawing.shapes[1].text, "Hello");
});

test("generates a pdf document", () => {
  const pdf = convertPltToPdf("IN;SP1;PW20;PA;PU0,0;PD100,0,100,100,0,100,0,0;");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.includes("/Type /Catalog"));
  assert.ok(pdf.includes("xref"));
  assert.ok(pdf.includes("1.417 w"));
});

test("applies manual line width overrides", () => {
  const drawing = parseHpgl("IN;SP1;PW20;PA;PU0,0;PD100,0,100,100,0,100,0,0;");
  const pdf = convertDrawingToPdf(drawing, {
    shapeLineWidthOverrides: {
      [drawing.shapes[0].id]: 8
    }
  });
  assert.ok(pdf.includes("8.000 w"));
});

test("parses absolute and relative arc commands into paths", () => {
  const absoluteArc = parseHpgl("IN;SP1;PA;PU100,0;PD;AA0,0,90,10;PU;");
  assert.equal(absoluteArc.shapes.length, 1);
  assert.equal(absoluteArc.shapes[0].type, "path");
  assert.ok(absoluteArc.shapes[0].points.length > 4);
  const absoluteEnd = absoluteArc.shapes[0].points.at(-1);
  assert.ok(Math.abs(absoluteEnd.x - 0) < 0.001);
  assert.ok(Math.abs(absoluteEnd.y - 100) < 0.001);

  const relativeArc = parseHpgl("IN;SP1;PA;PU100,0;PD;AR-100,0,90,10;PU;");
  assert.equal(relativeArc.shapes.length, 1);
  const relativeEnd = relativeArc.shapes[0].points.at(-1);
  assert.ok(Math.abs(relativeEnd.x - 0) < 0.001);
  assert.ok(Math.abs(relativeEnd.y - 100) < 0.001);
});

test("exports tiled fixed paper pdf pages", () => {
  const source = "IN;SP1;PA;PU0,0;PD12000,0,12000,16000,0,16000,0,0;";
  const layout = getTiledPdfLayout(source, {
    unitsPerInch: 1016,
    marginPt: 0,
    paperSize: "A4",
    orientation: "portrait"
  });
  assert.equal(layout.type, "tiled");
  assert.equal(layout.paperSize, "A4");
  assert.ok(layout.columns > 1);
  assert.ok(layout.rows > 1);

  const pdf = convertPltToPdf(source, {
    unitsPerInch: 1016,
    marginPt: 0,
    paperSize: "A4",
    orientation: "portrait"
  });
  assert.ok(pdf.includes(`/Count ${layout.pageCount}`));
  assert.ok(pdf.includes("/MediaBox [0 0 595.276 841.890]"));
});

test("uses standard A-series PDF page dimensions", () => {
  const source = "IN;SP1;PA;PU0,0;PD1000,0,1000,1000,0,1000,0,0;";
  const expected = {
    A0: [2383.937, 3370.394],
    A1: [1683.780, 2383.937],
    A2: [1190.551, 1683.780],
    A3: [841.890, 1190.551],
    A4: [595.276, 841.890]
  };

  for (const [paperSize, [widthPt, heightPt]] of Object.entries(expected)) {
    const layout = getTiledPdfLayout(source, {
      paperSize,
      orientation: "portrait",
      marginPt: 0
    });
    assert.equal(layout.pageWidthPt.toFixed(3), widthPt.toFixed(3));
    assert.equal(layout.pageHeightPt.toFixed(3), heightPt.toFixed(3));

    const pdf = convertPltToPdf(source, {
      paperSize,
      orientation: "portrait",
      marginPt: 0
    });
    assert.ok(pdf.includes(`/MediaBox [0 0 ${widthPt.toFixed(3)} ${heightPt.toFixed(3)}]`));
  }
});

test("converts PLT through hp2xx svg pipeline", async () => {
  const source = Buffer.from("IN;SP1;SI0.4,0.6;PU1000,1000;LBHELLO\x03;PU;", "utf8");
  const result = await convertPltBufferWithHp2xx(source, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 0
  });
  assert.ok(result.pdf.startsWith("%PDF-1.4"));
  assert.equal(result.layout.type, "tiled");
  assert.equal(result.layout.paperSize, "A4");
  assert.ok(result.pdf.includes("/MediaBox [0 0 595.276 841.890]"));
});

test("applies hp2xx svg line width override", async () => {
  const source = Buffer.from("IN;SP1;PU0,0;PD1000,0,1000,1000;", "utf8");
  const result = await convertPltBufferWithHp2xx(source, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 0,
    lineWidthMm: 2.5
  });
  assert.ok(result.svg.includes("stroke-width:2.500mm"));
  assert.ok(result.pdf.includes("7.087 w"));
});

test("draws a dashed PDF margin guide on each page", async () => {
  const source = Buffer.from("IN;SP1;PU0,0;PD1000,0,1000,1000;", "utf8");
  const result = await convertPltBufferWithHp2xx(source, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 10 * 72 / 25.4
  });
  assert.ok(result.pdf.includes("[3 3] 0 d"));
  assert.ok(result.pdf.includes("28.346 28.346 538.583 785.197 re"));
});

test("adds page numbers to generated PDF pages", async () => {
  const source = Buffer.from("IN;SP1;PA;PU0,0;PD12000,0,12000,16000,0,16000,0,0;", "utf8");
  const result = await convertPltBufferWithHp2xx(source, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 0
  });
  assert.ok(result.layout.pageCount > 1);
  assert.ok(result.pdf.includes(`(1 / ${result.layout.pageCount}) Tj`));
  assert.ok(result.pdf.includes(`(${result.layout.pageCount} / ${result.layout.pageCount}) Tj`));
});

test("times out hp2xx conversion", async () => {
  const source = Buffer.from("IN;SP1;PU0,0;PD1000,0,1000,1000;", "utf8");
  await assert.rejects(
    convertPltBufferWithHp2xx(source, {
      timeoutMs: 1
    }),
    ConversionTimeoutError
  );
});

test("limits conversion queue concurrency and rejects when full", async () => {
  const queue = new ConversionQueue({ concurrency: 1, queueLimit: 1 });
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const task = () => new Promise((resolvePromise) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    releases.push(() => {
      active -= 1;
      resolvePromise(active);
    });
  });

  const first = queue.run(task);
  const second = queue.run(task);
  await assert.rejects(queue.run(task), QueueFullError);
  assert.equal(queue.active, 1);
  assert.equal(queue.pending, 1);

  releases.shift()();
  await first;
  assert.equal(queue.active, 1);
  assert.equal(queue.pending, 0);

  releases.shift()();
  await second;
  assert.equal(maxActive, 1);
  assert.equal(queue.active, 0);
  assert.equal(queue.pending, 0);
});

test("preserves non-utf8 PLT bytes for hp2xx conversion", async () => {
  const source = Buffer.from([
    0x49, 0x4e, 0x3b,
    0x53, 0x50, 0x31, 0x3b,
    0x50, 0x55, 0x31, 0x30, 0x30, 0x2c, 0x31, 0x30, 0x30, 0x3b,
    0x4c, 0x42, 0xc3, 0xe6, 0xc1, 0xcf, 0x41, 0x03, 0x3b
  ]);
  const result = await convertPltBufferWithHp2xx(source, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 0
  });
  assert.ok(result.pdf.startsWith("%PDF-1.4"));
  assert.equal(result.layout.type, "tiled");
});

test("preserves utf-8 PLT labels through hp2xx conversion", async () => {
  const source = Buffer.from("IN;SP1;SI0.4,0.6;PU1000,1000;LB面料\x03;PU;", "utf8");
  const result = await convertPltBufferWithHp2xx(source, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 0
  });
  assert.ok(result.pdf.includes("<97626599> Tj"));
  assert.ok(!result.pdf.includes("闈㈡枡"));
});

test("decodes non-utf8 PLT text with gb18030 fallback", () => {
  const source = Buffer.from([
    0x49, 0x4e, 0x3b,
    0x4c, 0x42,
    0xc3, 0xe6, 0xc1, 0xcf,
    0x03,
    0x3b
  ]);
  assert.equal(decodePltBuffer(source), "IN;LB面料\x03;");
});

test("file conversion preserves non-utf8 PLT labels", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "plt-to-pdf-test-"));
  const inputPath = join(tempDir, "input.plt");
  const outputPath = join(tempDir, "output.pdf");
  try {
    await writeFile(inputPath, Buffer.from([
      0x49, 0x4e, 0x3b,
      0x4c, 0x42,
      0xc3, 0xe6, 0xc1, 0xcf,
      0x03,
      0x3b
    ]));
    await convertPltFile(inputPath, outputPath);
    const pdf = await readFile(outputPath, "utf8");
    assert.ok(pdf.includes("(面料) Tj"));
    assert.ok(!pdf.includes("�"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("allows base64 JSON upload overhead while enforcing decoded limit", () => {
  const maxDecodedBytes = 20 * 1024 * 1024;
  const encodedBodyBytes = JSON.stringify({
    sourceBase64: Buffer.alloc(maxDecodedBytes).toString("base64")
  }).length;
  assert.ok(encodedBodyBytes > maxDecodedBytes);
  assert.ok(encodedBodyBytes <= getMaxJsonUploadBytes(maxDecodedBytes));
});

test("sanitizes dangerous svg preview markup", () => {
  const svg = [
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">',
    '<script>alert(1)</script>',
    '<foreignObject><div onclick="alert(2)">x</div></foreignObject>',
    '<path d="M0 0 L10 10" onclick="alert(3)" stroke="url(javascript:alert(4))" style="stroke:rgb(0,0,0); fill:none; background:url(http://bad.test/a.png)" />',
    '<image href="http://bad.test/a.png" />',
    "</svg>"
  ].join("");
  const sanitized = sanitizeSvgInnerMarkup(svg);
  assert.ok(sanitized.includes("<path"));
  assert.ok(sanitized.includes('d="M0 0 L10 10"'));
  assert.ok(!sanitized.includes("script"));
  assert.ok(!sanitized.includes("foreignObject"));
  assert.ok(!sanitized.includes("onclick"));
  assert.ok(!sanitized.includes("javascript:"));
  assert.ok(!sanitized.includes("<image"));
  assert.ok(!sanitized.includes("url("));
});

test("tiles hp2xx svg using actual path bounds instead of full viewBox", () => {
  const svg = [
    '<svg viewBox="0 0 5000 5000" xmlns="http://www.w3.org/2000/svg">',
    '<g style="stroke:rgb(0,0,0); fill:none; stroke-width:0.100mm;">',
    '<path d="M 100, 100 L 200, 100 L 200, 200 L 100, 200 Z" />',
    "</g>",
    "</svg>"
  ].join("");
  const layout = getSvgPdfLayout(svg, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 0
  });
  assert.equal(layout.columns, 1);
  assert.equal(layout.rows, 1);
  assert.equal(layout.pageCount, 1);
});

test("treats hp2xx svg coordinates as PDF points", () => {
  const svg = [
    '<svg viewBox="0 0 566.929 566.929" xmlns="http://www.w3.org/2000/svg">',
    '<g style="stroke:rgb(0,0,0); fill:none; stroke-width:0.100mm;">',
    '<path d="M 0, 0 L 566.929, 0" />',
    "</g>",
    "</svg>"
  ].join("");
  const layout = getSvgPdfLayout(svg, {
    paperSize: "A4",
    orientation: "landscape",
    marginPt: 0
  });
  assert.equal(layout.columns, 1);
  assert.equal(layout.drawingWidthPt.toFixed(3), "567.212");
});

test("preserves svg stroke caps, joins, and cubic paths in generated pdf", () => {
  const svg = [
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">',
    '<g style="stroke:rgb(0,0,0); fill:none; stroke-width:0.100mm; stroke-linecap:butt; stroke-linejoin:miter;">',
    '<path d="M 10, 10 C 20, 20 30, 20 40, 10" />',
    "</g>",
    "</svg>"
  ].join("");
  const pdf = buildPdfFromSvg(svg, {
    paperSize: "A4",
    orientation: "portrait",
    marginPt: 0
  });
  assert.ok(pdf.includes("0 J"));
  assert.ok(pdf.includes("0 j"));
  assert.ok(pdf.includes(" c\nS"));
});
