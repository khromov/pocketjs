const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_REL = 9;
const SHT_PSP_REL = 0x700000a0;
const SHF_ALLOC = 2;

/**
 * Drop the symbol table and its string table from a PRX. The PSP kernel loads
 * the flat segment and applies the SHT_PSP_REL sections, whose entries name
 * segments by index, not symbols; `.symtab` and `.strtab` only serve debuggers
 * (337 KB of a Wolfensvelte EBOOT). Every allocated byte keeps its file offset;
 * the kept non-allocated sections (relocations, `.shstrtab`, `.comment`) are
 * re-laid after the segment in their original order, section indices are
 * renumbered, and a relocation section's link to the dropped symbol table
 * becomes 0. The unstripped PRX stays in the cargo target directory.
 */
export function stripPspPrx(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const shoff = u32(32), shcount = u16(48), shstrndx = u16(50);
  const sections = Array.from({ length: shcount }, (_, index) => {
    const at = shoff + index * 40;
    return { index, header: bytes.slice(at, at + 40), type: u32(at + 4), flags: u32(at + 8), offset: u32(at + 16), size: u32(at + 20), align: Math.max(1, u32(at + 32)) };
  });
  const dropped = (s: (typeof sections)[number]) =>
    s.index !== shstrndx && (s.flags & SHF_ALLOC) === 0 && (s.type === SHT_SYMTAB || s.type === SHT_STRTAB);
  if (!sections.some(dropped)) return bytes;
  const kept = sections.filter((s) => !dropped(s));
  const renumber = new Map(kept.map((s, index) => [s.index, index]));

  // Everything the kernel reads lives below the end of the last allocated section with file bytes.
  let imageEnd = 52 + u16(42) * u16(44);
  for (const s of sections) {
    if ((s.flags & SHF_ALLOC) !== 0 && s.type !== 8) imageEnd = Math.max(imageEnd, s.offset + s.size);
  }
  const chunks: Uint8Array[] = [bytes.subarray(0, imageEnd)];
  let at = imageEnd;
  for (const s of kept) {
    if (s.index === 0 || (s.flags & SHF_ALLOC) !== 0 || s.offset < imageEnd) continue;
    const pad = (s.align - (at % s.align)) % s.align;
    if (pad) chunks.push(new Uint8Array(pad));
    at += pad;
    new DataView(s.header.buffer).setUint32(16, at, true);
    chunks.push(bytes.subarray(s.offset, s.offset + s.size));
    at += s.size;
  }
  const headerPad = (4 - (at % 4)) % 4;
  if (headerPad) chunks.push(new Uint8Array(headerPad));
  const newShoff = at + headerPad;
  for (const s of kept) {
    const header = new DataView(s.header.buffer);
    const link = header.getUint32(24, true);
    header.setUint32(24, renumber.get(link) ?? 0, true);
    if (s.type === SHT_REL || s.type === SHT_RELA || s.type === SHT_PSP_REL) {
      const target = header.getUint32(28, true);
      const next = renumber.get(target);
      if (next === undefined) throw new Error(`stripPspPrx: relocation section ${s.index} targets dropped section ${target}`);
      header.setUint32(28, next, true);
    }
    chunks.push(s.header);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  const outView = new DataView(out.buffer);
  outView.setUint32(32, newShoff, true);
  outView.setUint16(48, kept.length, true);
  outView.setUint16(50, renumber.get(shstrndx)!, true);
  return out;
}

/** Check the flat image consumed by the PSP kernel before shipping a PRX. */
export function verifyPspPrx(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (reason: string): never => { throw new Error(`Invalid PSP PRX: ${reason}`); };
  const range = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) fail("truncated ELF");
  };
  range(0, 52);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (u32(0) !== 0x464c457f || bytes[4] !== 1 || bytes[5] !== 1 ||
      u16(16) !== 0xffa0 || u16(18) !== 8) fail("expected a little-endian MIPS PRX");
  const phoff = u32(28), shoff = u32(32);
  const phsize = u16(42), phcount = u16(44), shsize = u16(46), shcount = u16(48);
  if (phsize !== 32 || phcount !== 1 || shsize !== 40 || shcount === 0) fail("expected one load segment and section headers");
  range(phoff, phsize);
  range(shoff, shsize * shcount);
  const start = u32(phoff + 4), address = u32(phoff + 8);
  const filesz = u32(phoff + 16), memsz = u32(phoff + 20);
  if (u32(phoff) !== 1 || address !== 0 || filesz > memsz) fail("invalid flat load segment");
  range(start, filesz);
  for (let i = 0; i < shcount; i++) {
    const section = shoff + i * shsize;
    if (!(u32(section + 8) & 2)) continue; // SHF_ALLOC
    const addr = u32(section + 12), offset = u32(section + 16), size = u32(section + 20);
    if (addr + size > memsz) fail(`section ${i} exceeds loaded memory`);
    if (u32(section + 4) === 8 || size === 0) continue; // SHT_NOBITS
    range(offset, size);
    if (offset !== start + addr || addr + size > filesz) {
      fail(`section ${i} file offset does not match its load address; rebuild with the PocketJS PSP target`);
    }
  }
}
