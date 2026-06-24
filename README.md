# plt-to-pdf

Tools for garment pattern file conversion and layout.

## Web UI

The browser UI has two pages:

- `/index.html`: PLT to PDF conversion.
- `/pdf-to-plt.html`: PDF page layout and image export.

The PDF layout page currently supports:

- Load one multi-page PDF.
- Render every PDF page to canvas with PDF.js.
- Arrange pages on a Konva canvas stage.
- Adjust horizontal/vertical layout count.
- Crop every page by left/right/top/bottom millimeters.
- Optionally auto-crop each page to detected content bounds, with a configurable retained margin. This changes page dimensions and is intended only for preview or rough whitespace removal.
- Export the complete arranged canvas as one PNG.

```bash
npm install
npm run dev
```

Then open the local URL printed in the terminal.

Open `http://127.0.0.1:4173/` for PLT to PDF, or `http://127.0.0.1:4173/pdf-to-plt.html` for the PDF layout tool.

PLT export from PDF is not implemented yet. The button is shown as disabled so the workflow can keep the planned shape.

Auto-crop is optional and off by default. Turn it off to keep the original manual crop behavior and preserve page-size based layout.

## PLT to PDF CLI

The original CLI still converts `.plt` / HPGL plot files into PDF:

```bash
node src/cli.js input.plt output.pdf
```

Or, after `npm install`:

```bash
npx plt-to-pdf input.plt output.pdf
```

### Options

- `--units-per-inch 1016`
- `--margin 36`
- `--line-width 0.75`
- `--font-size 10`
- `--paper-size A4`: export tiled fixed paper pages, supports `A4`, `A3`, `A2`, `A1`, `A0`
- `--orientation auto`: supports `auto`, `portrait`, `landscape`

CLI arguments use PDF `pt` units. The web UI uses `mm` for PDF page crop controls.

Example:

```bash
node src/cli.js input.plt output.pdf --paper-size A4 --orientation auto
```

### hp2xx Server Conversion

The server-side PLT conversion pipeline still uses `hp2xx -> SVG -> PDF`:

```bash
tools/hp2xx -q -m svg -t -f output.svg input.plt
```

`hp2xx` is a command-line tool, not a long-running service. The bundled `tools/hp2xx` is the current macOS local build. For Linux deployment, compile or install `hp2xx` on that host and point to it with:

```bash
HP2XX_PATH=/path/to/hp2xx npm run dev
```
