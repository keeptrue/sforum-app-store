import { ZipFile } from "yazl";

export type ZipEntryInput =
  | string
  | Uint8Array
  | { data: string | Uint8Array; mode?: number };

export async function makeZip(
  entries: Record<string, ZipEntryInput>,
): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === "string" || value instanceof Uint8Array) {
      zip.addBuffer(Buffer.from(value), name);
      continue;
    }
    zip.addBuffer(
      Buffer.from(value.data),
      name,
      value.mode === undefined ? {} : { mode: value.mode },
    );
  }
  zip.end();

  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function elfHeader(machine = 0x3e): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write("\u007fELF", 0, "latin1");
  buffer[4] = 2;
  buffer[5] = 1;
  buffer[6] = 1;
  buffer.writeUInt16LE(2, 16);
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

export const themeManifest = {
  manifestVersion: 3,
  id: "sforum.theme-paper",
  name: "纸页",
  description: "纸张质感的默认主题。",
  url: "https://github.com/example/sforum-theme-paper",
  author: { name: "SForum" },
  version: "0.8.0",
  type: "theme",
  sforumVersion: ">=1.2.0 <2.0.0",
};

export const pluginManifest = {
  manifestVersion: 3,
  id: "sforum.markdown-plus",
  name: "Markdown Plus",
  description: "额外的 Markdown 语法。",
  url: "https://github.com/example/sforum-markdown-plus",
  author: { name: "SForum", url: "https://github.com/example" },
  version: "1.4.2",
  type: "plugin",
  sforumVersion: ">=1.2.0 <2.0.0",
  capabilities: ["host.api"],
  backend: {
    entry: "backend/plugin",
    rpc: "hashicorp-go-plugin",
    protocolVersion: 2,
    digest: "0000000000000000000000000000000000000000000000000000000000000000",
    hostApiVersion: "sforum.host@2",
  },
};
