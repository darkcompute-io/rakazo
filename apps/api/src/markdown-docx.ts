// AgentLoom: a project's Markdown as a Word document, so "Download as Word" needs
// no computer. Covers what bots write: headings, paragraphs with bold, italic,
// code and links, bullet and numbered lists, tables, code blocks, quotes and rules.
import {
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { lexer, type Token, type Tokens } from "marked";

type Inline = TextRun | ExternalHyperlink;
type Style = { bold?: boolean; italics?: boolean; code?: boolean; strike?: boolean };

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function run(text: string, style: Style): TextRun {
  return new TextRun({
    text: decode(text),
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    ...(style.code
      ? { font: "Consolas", shading: { type: ShadingType.CLEAR, fill: "F1F1EF", color: "auto" } }
      : {}),
  });
}

function inline(tokens: Token[] | undefined, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        out.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((token as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case "del":
        out.push(...inline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push(run((token as Tokens.Codespan).text, { ...style, code: true }));
        break;
      case "br":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const children = inline(link.tokens, style).filter(
          (child): child is TextRun => child instanceof TextRun,
        );
        if (/^https?:\/\//i.test(link.href))
          out.push(new ExternalHyperlink({ link: link.href, children }));
        else out.push(...children);
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        out.push(...(text.tokens?.length ? inline(text.tokens, style) : [run(text.text, style)]));
        break;
      }
      case "escape":
        out.push(run((token as Tokens.Escape).text, style));
        break;
      default:
        if ("text" in token && typeof token.text === "string") out.push(run(token.text, style));
    }
  }
  return out;
}

function list(token: Tokens.List, level: number, out: (Paragraph | Table)[]) {
  for (const item of token.items) {
    const first = item.tokens.find((t) => t.type === "text" || t.type === "paragraph") as
      | Tokens.Text
      | Tokens.Paragraph
      | undefined;
    const prefix = item.task ? [new TextRun({ text: item.checked ? "☑ " : "☐ " })] : [];
    out.push(
      new Paragraph({
        children: [
          ...prefix,
          ...inline(
            first?.tokens ?? [
              { type: "text", raw: first?.text ?? "", text: first?.text ?? "" } as Tokens.Text,
            ],
          ),
        ],
        ...(token.ordered
          ? { numbering: { reference: "numbered", level: Math.min(level, 8) } }
          : { bullet: { level: Math.min(level, 8) } }),
      }),
    );
    for (const child of item.tokens) {
      if (child.type === "list") list(child as Tokens.List, level + 1, out);
    }
  }
}

function blocks(tokens: Token[], out: (Paragraph | Table)[]) {
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        out.push(
          new Paragraph({
            heading: HEADINGS[Math.min(heading.depth, 6) - 1],
            children: inline(heading.tokens),
          }),
        );
        break;
      }
      case "paragraph":
        out.push(
          new Paragraph({
            children: inline((token as Tokens.Paragraph).tokens),
            spacing: { after: 120 },
          }),
        );
        break;
      case "list":
        list(token as Tokens.List, 0, out);
        break;
      case "code":
        for (const line of (token as Tokens.Code).text.split("\n")) {
          out.push(
            new Paragraph({
              children: [run(line || " ", { code: true })],
              shading: { type: ShadingType.CLEAR, fill: "F1F1EF", color: "auto" },
            }),
          );
        }
        break;
      case "blockquote": {
        // Quoted text keeps its content; italics mark it as a quote.
        for (const child of (token as Tokens.Blockquote).tokens) {
          if (child.type === "paragraph") {
            out.push(
              new Paragraph({
                children: inline((child as Tokens.Paragraph).tokens, { italics: true }),
                indent: { left: 360 },
              }),
            );
          } else {
            blocks([child], out);
          }
        }
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        const cell = (c: Tokens.TableCell, header: boolean) =>
          new TableCell({
            children: [new Paragraph({ children: inline(c.tokens, header ? { bold: true } : {}) })],
            ...(header
              ? { shading: { type: ShadingType.CLEAR, fill: "F1F1EF", color: "auto" } }
              : {}),
          });
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: table.header.map((c) => cell(c, true)) }),
              ...table.rows.map(
                (row) => new TableRow({ children: row.map((c) => cell(c, false)) }),
              ),
            ],
          }),
        );
        out.push(new Paragraph({ children: [] }));
        break;
      }
      case "hr":
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } },
          }),
        );
        break;
      case "space":
        break;
      default:
        if ("text" in token && typeof token.text === "string" && token.text.trim()) {
          out.push(new Paragraph({ children: [run(token.text, {})] }));
        }
    }
  }
}

/** A Word document (.docx bytes) from Markdown. */
export async function markdownToDocx(markdown: string, title: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  blocks(lexer(markdown, { gfm: true }), children);
  const doc = new Document({
    title,
    creator: "AgentLoom",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        {
          reference: "numbered",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            indent: { left: 720 * (level + 1), hanging: 360 },
          })),
        },
      ],
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [] })] }],
  });
  return Packer.toBuffer(doc);
}
