# plt-to-pdf

Convert `.plt` / HPGL plot files into PDF.

## Usage

```bash
node src/cli.js input.plt output.pdf
```

Or, after `npm install`:

```bash
npx plt-to-pdf input.plt output.pdf
```

## Web UI

```bash
npm run dev
```

Then open the local URL printed in the terminal.

### Options

- `--units-per-inch 1016`
- `--margin 36`
- `--line-width 0.75`
- `--font-size 10`
- `--paper-size A4`：按固定纸张分张导出，支持 `A4`、`A3`、`A2`、`A1`、`A0`
- `--orientation auto`：纸张方向，支持 `auto`、`portrait`、`landscape`

命令行参数沿用 PDF 的 `pt` 单位；Web UI 会把边距、线宽显示为更直观的 `mm`，提交转换时再换算成 `pt`。

示例：

```bash
node src/cli.js input.plt output.pdf --paper-size A4 --orientation auto
```

### 支持说明

- 支持文件内 `PW` 线宽指令
- 线宽会在 PDF 中按原始文件的笔宽渲染
- 在网页里可以点选一根线，手动把它加粗
- 不指定 `--paper-size` 时保持原来的单页自适应输出
- 指定 A 系列纸张后会按原始比例平铺分张，不会缩小图形塞进单页

### hp2xx 服务端转换

网页转换优先走服务端 `hp2xx -> SVG -> PDF` 管线：

```bash
tools/hp2xx -q -m svg -t -f output.svg input.plt
```

`hp2xx` 是命令行工具，不是常驻服务。本仓库的 `tools/hp2xx` 是当前 macOS 本机编译产物；部署到 Linux 服务器时需要在 Linux 镜像或机器上重新编译/安装 `hp2xx`，并通过 `HP2XX_PATH=/path/to/hp2xx npm run dev` 指向 Linux 上的可执行文件。
