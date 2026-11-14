import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripPspPrx, verifyPspPrx } from "../tools/psp-prx.ts";
import { resolvePspBuildToolchain } from "../tools/build/toolchains/psp/build.ts";

// ELF32 layout reduced from a real failing PSP build: the RX segment began
// at file offset 0xe0, but 64-byte-aligned rodata shifted the R segment by
// another 32 bytes. prxgen retained that gap when flattening the segments.
function prx(rodataGap = 0): Uint8Array {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u16 = (at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (at: number, value: number) => view.setUint32(at, value, true);
  u32(0, 0x464c457f); bytes[4] = 1; bytes[5] = 1;
  u16(16, 0xffa0); u16(18, 8); u32(28, 52); u32(32, 0x300);
  u16(42, 32); u16(44, 1); u16(46, 40); u16(48, 4);
  u32(52, 1); u32(56, 0xe0); u32(68, 0x120); u32(72, 0x180);
  for (const [i, type, addr, offset, size] of [
    [1, 1, 0, 0xe0, 0x80],
    [2, 1, 0x80, 0x160 + rodataGap, 0x80],
    [3, 8, 0x120, 0x200, 0x60],
  ]) {
    const at = 0x300 + i! * 40;
    u32(at + 4, type!); u32(at + 8, 2); u32(at + 12, addr!);
    u32(at + 16, offset!); u32(at + 20, size!);
  }
  return bytes;
}

describe("PSP PRX load layout", () => {
  test("accepts a flat image including BSS", () => expect(() => verifyPspPrx(prx())).not.toThrow());
  test("rejects the alignment gap that crashes sceLoaderCore", () => {
    expect(() => verifyPspPrx(prx(32))).toThrow("file offset does not match its load address");
  });
  test("rejects a truncated image", () => expect(() => verifyPspPrx(prx().slice(0, 80))).toThrow("truncated"));
  test("rejects a section outside the kernel allocation", () => {
    const bytes = prx(); new DataView(bytes.buffer).setUint32(0x300 + 3 * 40 + 20, 0x100, true);
    expect(() => verifyPspPrx(bytes)).toThrow("exceeds loaded memory");
  });
});

// A PRX as cargo-psp's prxgen leaves it: the flat segment, a PSP relocation
// section linked to .symtab, then .symtab, .shstrtab and .strtab.
function prxWithSymbols(): Uint8Array {
  const names = "\0.text\0.bss\0.rel.text\0.symtab\0.shstrtab\0.strtab\0";
  const name = (n: string) => names.indexOf(`\0${n}\0`) + 1;
  const bytes = new Uint8Array(0x200 + 7 * 40);
  const view = new DataView(bytes.buffer);
  const u16 = (at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (at: number, value: number) => view.setUint32(at, value, true);
  u32(0, 0x464c457f); bytes[4] = 1; bytes[5] = 1;
  u16(16, 0xffa0); u16(18, 8); u32(28, 52); u32(32, 0x200);
  u16(42, 32); u16(44, 1); u16(46, 40); u16(48, 7); u16(50, 5);
  u32(52, 1); u32(56, 0x80); u32(68, 0x40); u32(72, 0x60);
  for (let i = 0; i < 0x40; i++) bytes[0x80 + i] = i + 1; // .text
  for (let i = 0; i < 16; i++) bytes[0xc0 + i] = 0xa0 + i; // .rel.text
  bytes.fill(0x55, 0xd0, 0xf0); // .symtab
  bytes.set(new TextEncoder().encode(names), 0xf0);
  bytes.fill(0x66, 0x140, 0x150); // .strtab
  // [index, name, type, flags, addr, offset, size, link, info, align]
  for (const [i, n, type, flags, addr, offset, size, link, info, align] of [
    [1, name(".text"), 1, 6, 0, 0x80, 0x40, 0, 0, 16],
    [2, name(".bss"), 8, 3, 0x40, 0xc0, 0x20, 0, 0, 4],
    [3, name(".rel.text"), 0x700000a0, 0x40, 0, 0xc0, 16, 4, 1, 4],
    [4, name(".symtab"), 2, 0, 0, 0xd0, 32, 6, 1, 4],
    [5, name(".shstrtab"), 3, 0, 0, 0xf0, names.length, 0, 0, 1],
    [6, name(".strtab"), 3, 0, 0, 0x140, 16, 0, 0, 1],
  ] as const) {
    const at = 0x200 + i * 40;
    u32(at, n); u32(at + 4, type); u32(at + 8, flags); u32(at + 12, addr); u32(at + 16, offset);
    u32(at + 20, size); u32(at + 24, link); u32(at + 28, info); u32(at + 32, align);
  }
  return bytes;
}

function sectionTable(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shoff = view.getUint32(32, true), count = view.getUint16(48, true), shstrndx = view.getUint16(50, true);
  const strings = view.getUint32(shoff + shstrndx * 40 + 16, true);
  const text = (at: number) => { let s = ""; for (let i = strings + at; bytes[i]; i++) s += String.fromCharCode(bytes[i]!); return s; };
  return Array.from({ length: count }, (_, i) => {
    const at = shoff + i * 40;
    return {
      name: text(view.getUint32(at, true)), offset: view.getUint32(at + 16, true), size: view.getUint32(at + 20, true),
      link: view.getUint32(at + 24, true), info: view.getUint32(at + 28, true),
    };
  });
}

describe("stripPspPrx", () => {
  test("drops .symtab and .strtab and keeps every loaded byte at its offset", () => {
    const before = prxWithSymbols();
    const after = stripPspPrx(before);
    expect(() => verifyPspPrx(before)).not.toThrow();
    expect(() => verifyPspPrx(after)).not.toThrow();
    expect(after.length).toBeLessThan(before.length);
    // Program header and segment unchanged (the ELF header's section-table fields move).
    expect(after.subarray(52, 0xc0)).toEqual(before.subarray(52, 0xc0));
    const sections = sectionTable(after);
    expect(sections.map((s) => s.name)).toEqual(["", ".text", ".bss", ".rel.text", ".shstrtab"]);
    const rel = sections[3]!;
    expect(rel.link).toBe(0); // its symbol table is gone; PSP relocations name segments, not symbols
    expect(rel.info).toBe(1); // still applies to .text
    expect(after.subarray(rel.offset, rel.offset + rel.size)).toEqual(before.subarray(0xc0, 0xd0));
  });
  test("returns a PRX without a symbol table unchanged", () => {
    const once = stripPspPrx(prxWithSymbols());
    expect(stripPspPrx(once)).toBe(once);
  });
});

// Opt in after `pocket target add psp`, with POCKETJS_LLVM_BIN naming an LLVM
// whose clang assembles the fixture: this exercises the pinned Rust linker and
// prxgen rather than a source-text check. The PSP guest also uses this LLVM.
test.skipIf(process.env.POCKETJS_TEST_PSP_LINK !== "1")("links aligned MIPS data into a loadable PRX", () => {
  const toolchain = resolvePspBuildToolchain();
  const llvmBin = process.env.POCKETJS_LLVM_BIN;
  if (!llvmBin) throw new Error("POCKETJS_TEST_PSP_LINK=1 needs POCKETJS_LLVM_BIN for clang");
  const dir = mkdtempSync(join(tmpdir(), "pocketjs-prx-"));
  const run = (cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { env: toolchain.environment });
    if (!result.success) throw new Error(`${result.stderr.toString()} (signal=${result.signalCode})`);
    return result.stdout.toString().trim();
  };
  try {
    const rust = [toolchain.rustup, "run", toolchain.rustToolchain, "rustc"];
    const sysroot = run([...rust, "--print", "sysroot"]);
    const host = run([...rust, "-vV"]).match(/^host: (.+)$/m)![1]!;
    const linker = new URL("../tools/psp-linker.ts", import.meta.url).pathname;
    expect(toolchain.environment.POCKET_PSP_LLD).toBe(join(sysroot, "lib/rustlib", host, "bin/rust-lld"));
    const target = JSON.parse(readFileSync(new URL("../tools/build/toolchains/psp/mipsel-sony-psp.json", import.meta.url), "utf8"));
    const object = join(dir, "aligned.o"), elf = join(dir, "aligned.elf"), prxFile = join(dir, "aligned.prx");
    writeFileSync(join(dir, "link.ld"), target["link-script"]);
    run([join(llvmBin, "clang"), "-target", "mipsel-sony-psp", "-march=mips2", "-mno-abicalls", "-fno-pic", "-c",
      new URL("fixtures/psp-prx/aligned.s", import.meta.url).pathname, "-o", object]);
    run([linker, "-flavor", "gnu", "--nmagic", "--emit-relocs", "--eh-frame-hdr", "-T", join(dir, "link.ld"), object, "-o", elf]);
    run([Bun.which("prxgen", { PATH: toolchain.environment.PATH })!, elf, prxFile]);
    verifyPspPrx(readFileSync(prxFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
