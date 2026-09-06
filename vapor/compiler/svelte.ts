// vapor/compiler/svelte.ts — the Svelte front end of Pocket Vapor.
//
// A component written with Svelte 5 runes and the <row> vocabulary is lowered
// to the Vue-subset TSX that compile.ts consumes, then compiled by the
// unchanged back end. The lowering is source-to-source: every expression and
// statement is copied from the .svelte file verbatim (TypeScript annotations
// included — the back end needs `ref<Todo[]>` and `(d: number)`), and only
// three kinds of text edit are made:
//
//   - `let x = $state(seed)` becomes `const x = ref(seed)` and
//     `const d = $derived(e)` becomes `const d = computed(() => e)`;
//   - an identifier that names a rune gets `.value` appended;
//   - inside a child component, an identifier that names a prop gets `props.`
//     prefixed, and the component becomes a module-level function — the shape
//     compile.ts inlines to zero-cost paint code.
//
// Template nodes map one-to-one: <row> stays <row>, {#each} becomes `.map()`,
// {#if} becomes `{cond ? <row/> : null}` per child, a component use stays a
// JSX use. Every generated line records the .svelte line it came from, so a
// diagnostic the back end raises is reported at the .svelte location.
//
// Under the oracle the same .svelte runs unmodified on real Svelte 5
// (vapor/oracle/entry-svelte.ts). The parity suite compares that against the
// Vue oracle running the generated TSX, cell for cell, after every press.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse, type AST } from "svelte/compiler";
import ts from "typescript";
import {
  compileVaporApp,
  type CompiledApp,
  type CompileOptions,
  type VaporTargetName,
} from "./compile.ts";

export interface LowerOptions {
  /** Read a file by absolute path; tests pass an in-memory map. */
  readFile?: (absPath: string) => string;
  /**
   * Directory the generated TSX will be written to. Relative host imports are
   * re-relativized against it so the written file loads under the Vue oracle.
   */
  importBase?: string;
}

export interface SourceLoc {
  file: string;
  line: number;
}

export interface SvelteLowering {
  tsx: string;
  /** index = generated line − 1; null = a synthesized line with no source */
  lines: (SourceLoc | null)[];
  /** absolute paths of the child components inlined into the program */
  children: string[];
}

export class SvelteFrontError extends Error {
  constructor(where: string, code: string, message: string) {
    super(`${where} — ${code}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// AST plumbing
// ---------------------------------------------------------------------------

// Svelte's modern AST carries ESTree (acorn) nodes for expressions with
// `start`/`end` offsets on every node; that is all the lowering needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = { type: string; start: number; end: number; [key: string]: any };

function isNode(v: unknown): v is Node {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Node).type === "string" &&
    typeof (v as Node).start === "number"
  );
}

interface Chunk {
  text: string;
  loc: SourceLoc | null;
}

interface Edit {
  pos: number;
  text: string;
}

const HOST_INPUT = /\/host\/input(\.ts)?$/;
const HOST_SCREEN = /\/host\/screen(\.ts)?$/;
const HOST_VALUE_IMPORTS = new Set(["Button", "RelativeAxis", "RelativeAxisUnits", "SCREEN"]);
const HOST_FN_IMPORTS = new Set(["onButton", "onAxisDelta"]);

const FORBIDDEN_RUNES = new Set([
  "$effect",
  "$effect.pre",
  "$effect.root",
  "$effect.tracking",
  "$effect.pending",
  "$inspect",
  "$inspect.trace",
  "$bindable",
  "$host",
  "$state.raw",
  "$state.snapshot",
  "$state.eager",
]);

// Svelte's whitespace rules (phases/3-transform/utils.js clean_nodes): text
// runs at the edges of a fragment are trimmed, a run between a text node and
// a non-text node collapses to one space, and whitespace next to an
// expression tag is kept verbatim because the two render as one text node.
const STARTS_WS = /^[ \t\r\n]+/;
const ENDS_WS = /[ \t\r\n]+$/;
const NOT_WS = /[^ \t\r\n]/;

/** Replace a Text node's leading whitespace run; its `start` moves past the run so a diagnostic points at the text. */
function trimStart(text: Node, replacement: string): void {
  const run = STARTS_WS.exec(text.data as string)?.[0].length ?? 0;
  if (run === 0) return;
  text.data = replacement + (text.data as string).slice(run);
  text.start += run;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function colOf(source: string, offset: number): number {
  return offset - source.lastIndexOf("\n", offset - 1);
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

/**
 * A statement copied out of an indented <script> keeps its continuation
 * lines' indentation relative to its own line, so the generated file is
 * indented once, not twice. Only leading spaces up to that line's
 * indentation are removed; a line indented less is left alone.
 */
function dedent(text: string, width: number): string {
  if (width <= 0) return text;
  const lead = new RegExp(`^ {0,${width}}`);
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? l : l.replace(lead, "")))
    .join("\n");
}

/** Leading spaces of the line that holds `offset`: the indentation to remove. */
function indentAt(source: string, offset: number): number {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  let n = 0;
  while (source.charCodeAt(lineStart + n) === 32) n++;
  return n;
}

function applyEdits(source: string, start: number, end: number, edits: Edit[]): string {
  let out = source.slice(start, end);
  const sorted = [...edits].sort((a, b) => b.pos - a.pos);
  for (const e of sorted) {
    const i = e.pos - start;
    out = out.slice(0, i) + e.text + out.slice(i);
  }
  return out;
}

function patternNames(p: Node, out: string[]): void {
  switch (p.type) {
    case "Identifier":
      out.push(p.name);
      return;
    case "ObjectPattern":
      for (const prop of p.properties as Node[]) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      return;
    case "ArrayPattern":
      for (const el of p.elements as (Node | null)[]) if (el) patternNames(el, out);
      return;
    case "AssignmentPattern":
      patternNames(p.left, out);
      return;
    case "RestElement":
      patternNames(p.argument, out);
      return;
    default:
      return;
  }
}

function declaredIn(statements: Node[]): string[] {
  const out: string[] = [];
  for (const s of statements) {
    if (s.type === "VariableDeclaration") for (const d of s.declarations as Node[]) patternNames(d.id, out);
    else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) out.push(s.id.name);
  }
  return out;
}

/** `$state`, `$derived.by`, … for a call's callee; null for anything else. */
function runeName(callee: Node): string | null {
  if (callee.type === "Identifier" && callee.name.startsWith("$")) return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name.startsWith("$") &&
    callee.property.type === "Identifier"
  )
    return `${callee.object.name}.${callee.property.name}`;
  return null;
}

function isKeymapLiteral(init: Node): boolean {
  return (
    init.type === "ObjectExpression" &&
    init.properties.length > 0 &&
    (init.properties as Node[]).every((p) => p.type === "Property" && p.computed)
  );
}

/** A literal-only initializer the back end folds at module level. */
function isStatic(node: Node, allowed: Set<string>): boolean {
  switch (node.type) {
    case "Literal":
      return node.value === null || typeof node.value !== "object";
    case "TemplateLiteral":
      return node.expressions.length === 0;
    case "UnaryExpression":
      return ["-", "+", "!"].includes(node.operator) && isStatic(node.argument, allowed);
    case "BinaryExpression":
    case "LogicalExpression":
      return isStatic(node.left, allowed) && isStatic(node.right, allowed);
    case "ConditionalExpression":
      return (
        isStatic(node.test, allowed) && isStatic(node.consequent, allowed) && isStatic(node.alternate, allowed)
      );
    case "ArrayExpression":
      return (node.elements as (Node | null)[]).every((el) => el !== null && el.type !== "SpreadElement" && isStatic(el, allowed));
    case "ObjectExpression":
      return (node.properties as Node[]).every(
        (p) =>
          p.type === "Property" &&
          !p.computed &&
          (p.key.type === "Identifier" || p.key.type === "Literal") &&
          isStatic(p.value, allowed),
      );
    case "MemberExpression":
      return isStatic(node.object, allowed) && (!node.computed || isStatic(node.property, allowed));
    case "Identifier":
      return allowed.has(node.name);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// One .svelte file
// ---------------------------------------------------------------------------

class FileCtx {
  readonly ast: AST.Root;
  readonly dir: string;

  constructor(
    readonly file: string,
    readonly source: string,
  ) {
    this.dir = dirname(resolve(file));
    try {
      this.ast = parse(source, { modern: true });
    } catch (e) {
      const err = e as { message?: string; start?: { line?: number; column?: number } };
      const where =
        err.start?.line !== undefined ? `${file}:${err.start.line}:${(err.start.column ?? 0) + 1}` : file;
      throw new SvelteFrontError(where, "VSV100", err.message ?? String(e));
    }
  }

  loc(offset: number): SourceLoc {
    return { file: this.file, line: lineOf(this.source, offset) };
  }

  where(offset?: number): string {
    if (offset === undefined) return this.file;
    return `${this.file}:${lineOf(this.source, offset)}:${colOf(this.source, offset)}`;
  }

  fail(at: Node | number | undefined, code: string, message: string): never {
    const offset = typeof at === "number" ? at : at?.start;
    throw new SvelteFrontError(this.where(offset), code, message);
  }

  slice(node: Node): string {
    return dedent(this.source.slice(node.start, node.end), indentAt(this.source, node.start));
  }
}

/**
 * Applies the identifier edits to a subtree: `.value` after a rune reference,
 * `props.` before a prop reference. Scope-aware so a parameter or block local
 * that reuses the name is left alone — except that a rune or prop name may not
 * be shadowed at all (VSV109), which keeps the edit set unambiguous.
 */
class Rewriter {
  constructor(
    private readonly f: FileCtx,
    private readonly runes: ReadonlySet<string>,
    private readonly props: ReadonlySet<string>,
  ) {}

  rewrite(node: Node, locals: readonly string[][] = []): string {
    const edits: Edit[] = [];
    this.visit(node, null, "", locals, edits);
    return dedent(applyEdits(this.f.source, node.start, node.end, edits), indentAt(this.f.source, node.start));
  }

  checkShadow(names: readonly string[], at: Node): void {
    for (const n of names) {
      if (this.runes.has(n) || this.props.has(n))
        this.f.fail(at, "VSV109", `"${n}" shadows a ${this.runes.has(n) ? "rune" : "prop"} of the same name`);
    }
  }

  private tracked(name: string): boolean {
    return this.runes.has(name) || this.props.has(name);
  }

  private visit(node: Node, parent: Node | null, key: string, scopes: readonly string[][], edits: Edit[]): void {
    switch (node.type) {
      case "Identifier":
        this.identifier(node, parent, key, scopes, edits);
        return;
      case "Property":
        if (node.shorthand) {
          const name = node.key.name as string;
          if (this.tracked(name) && !scopes.some((s) => s.includes(name)))
            this.f.fail(node, "VSV105", `shorthand property { ${name} } cannot carry a rune or prop; write ${name}: ${name}`);
          return;
        }
        if (node.computed) this.visit(node.key, node, "key", scopes, edits);
        this.visit(node.value, node, "value", scopes, edits);
        return;
      case "MemberExpression":
        this.visit(node.object, node, "object", scopes, edits);
        if (node.computed) this.visit(node.property, node, "property", scopes, edits);
        return;
      case "CallExpression": {
        const rune = runeName(node.callee);
        if (rune) this.runeMisuse(node, rune);
        this.visit(node.callee, node, "callee", scopes, edits);
        for (const a of node.arguments as Node[]) this.visit(a, node, "arguments", scopes, edits);
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const names: string[] = [];
        for (const p of node.params as Node[]) patternNames(p, names);
        this.checkShadow(names, node);
        this.visit(node.body, node, "body", [...scopes, names], edits);
        return;
      }
      case "BlockStatement": {
        const names = declaredIn(node.body);
        this.checkShadow(names, node);
        const inner = [...scopes, names];
        for (const s of node.body as Node[]) this.visit(s, node, "body", inner, edits);
        return;
      }
      case "ForStatement": {
        const names = node.init?.type === "VariableDeclaration" ? declaredIn([node.init]) : [];
        this.checkShadow(names, node);
        const inner = [...scopes, names];
        for (const k of ["init", "test", "update", "body"]) if (node[k]) this.visit(node[k], node, k, inner, edits);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const names = node.left.type === "VariableDeclaration" ? declaredIn([node.left]) : [];
        this.checkShadow(names, node);
        const inner = [...scopes, names];
        for (const k of ["left", "right", "body"]) this.visit(node[k], node, k, inner, edits);
        return;
      }
      case "CatchClause": {
        const names: string[] = [];
        if (node.param) patternNames(node.param, names);
        this.checkShadow(names, node);
        this.visit(node.body, node, "body", [...scopes, names], edits);
        return;
      }
      case "LabeledStatement":
        this.visit(node.body, node, "body", scopes, edits);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        this.f.fail(node, "VSV105", "classes are outside the subset");
      // falls through (never)
      default:
        if (node.type.startsWith("TS")) {
          // type syntax is copied verbatim; only value-position wrappers are walked
          if (
            node.type === "TSAsExpression" ||
            node.type === "TSSatisfiesExpression" ||
            node.type === "TSNonNullExpression" ||
            node.type === "TSTypeAssertion" ||
            node.type === "TSInstantiationExpression"
          )
            this.visit(node.expression, node, "expression", scopes, edits);
          return;
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === "loc" || k === "range" || k === "leadingComments" || k === "trailingComments" || k === "metadata")
            continue;
          if (Array.isArray(v)) {
            for (const c of v) if (isNode(c)) this.visit(c, node, k, scopes, edits);
          } else if (isNode(v)) this.visit(v, node, k, scopes, edits);
        }
    }
  }

  private identifier(node: Node, parent: Node | null, key: string, scopes: readonly string[][], edits: Edit[]): void {
    const name = node.name as string;
    if (parent) {
      const declaring =
        ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") && key === "id") ||
        (parent.type === "VariableDeclarator" && key === "id") ||
        ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && key === "key") ||
        parent.type === "ImportSpecifier" ||
        parent.type === "ImportDefaultSpecifier" ||
        parent.type === "ExportSpecifier";
      if (declaring) return;
    }
    if (scopes.some((s) => s.includes(name))) return;
    if (this.runes.has(name)) edits.push({ pos: node.end, text: ".value" });
    else if (this.props.has(name)) edits.push({ pos: node.start, text: "props." });
  }

  private runeMisuse(node: Node, rune: string): never {
    if (FORBIDDEN_RUNES.has(rune) || rune.startsWith("$effect") || rune.startsWith("$inspect"))
      this.f.fail(node, "VSV101", `${rune} is outside the Pocket Vapor subset (state is $state/$derived, input is onButton/onAxisDelta)`);
    this.f.fail(node, "VSV102", `${rune} is only allowed as the initializer of a top-level <script> declaration`);
  }
}

// ---------------------------------------------------------------------------
// The lowering
// ---------------------------------------------------------------------------

interface ChildComponent {
  name: string;
  file: string;
  /** prop name -> emitted */
  props: string[];
}

class SvelteLowerer {
  private readonly readFile: (p: string) => string;
  private readonly importBase: string | undefined;

  /** module-level type declarations by name (interface/type text, `export` stripped) */
  private readonly types = new Map<string, Chunk>();
  private readonly hostImports: Chunk[] = [];
  private readonly moduleScript: Chunk[] = [];
  private readonly hoisted: Chunk[] = [];
  private readonly componentFns: Chunk[] = [];
  private readonly setup: Chunk[] = [];
  private readonly template: Chunk[] = [];
  private readonly children = new Map<string, ChildComponent>();
  private readonly childFiles: string[] = [];

  constructor(opts: LowerOptions) {
    this.readFile = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
    this.importBase = opts.importBase;
  }

  lower(file: string, source: string): SvelteLowering {
    const f = new FileCtx(file, source);
    const root = f.ast;
    if (root.css) f.fail(root.css as unknown as Node, "VSV111", '<style> is outside the subset: looks come from class="bg-* text-* align-*"');
    if (root.options) f.fail(root.options as unknown as Node, "VSV111", "<svelte:options> is not supported");

    // ---- module script: consts + types, verbatim ----
    const allowed = new Set<string>();
    for (const stmt of (root.module?.content.body ?? []) as Node[]) {
      if (stmt.type === "TSInterfaceDeclaration" || stmt.type === "TSTypeAliasDeclaration") {
        this.addType(f, stmt.id.name, f.slice(stmt), f.loc(stmt.start));
      } else if (stmt.type === "VariableDeclaration" && stmt.kind === "const") {
        for (const d of stmt.declarations as Node[]) {
          if (d.id.type !== "Identifier") f.fail(d, "VSV105", "<script module> consts need a simple name");
          if (!d.init || !isStatic(d.init, allowed)) f.fail(d, "VSV105", "<script module> consts must be literal data");
          allowed.add(d.id.name);
        }
        this.moduleScript.push({ text: f.slice(stmt), loc: f.loc(stmt.start) });
      } else f.fail(stmt, "VSV105", `unsupported <script module> statement: ${stmt.type}`);
    }

    // ---- instance script, pass 1: classify names ----
    const body = (root.instance?.content.body ?? []) as Node[];
    const runes = new Set<string>();
    const statics = new Set<string>();
    const keymaps = new Set<string>();
    const fns = new Set<string>();
    let hostOnButton: string | null = null;
    let hostOnAxisDelta: string | null = null;

    for (const stmt of body) {
      if (stmt.type === "ImportDeclaration") {
        const kind = this.importKind(f, stmt);
        if (kind === "host") {
          for (const spec of stmt.specifiers as Node[]) {
            const imported = spec.imported.name as string;
            const local = spec.local.name as string;
            if (HOST_VALUE_IMPORTS.has(imported)) allowed.add(local);
            else if (imported === "onButton") hostOnButton = local;
            else if (imported === "onAxisDelta") hostOnAxisDelta = local;
            else f.fail(spec, "VSV104", `unsupported host import: ${imported}`);
          }
        }
        continue;
      }
      if (stmt.type === "VariableDeclaration") {
        for (const d of stmt.declarations as Node[]) {
          const init = d.init as Node | null;
          const rune = init?.type === "CallExpression" ? runeName(init.callee) : null;
          if (rune === "$props") f.fail(d, "VSV110", "$props() is not supported on the root component (v1)");
          if (rune && rune !== "$state" && rune !== "$derived" && rune !== "$derived.by") {
            if (FORBIDDEN_RUNES.has(rune) || rune.startsWith("$effect") || rune.startsWith("$inspect"))
              f.fail(init!, "VSV101", `${rune} is outside the Pocket Vapor subset`);
            f.fail(init!, "VSV101", `unknown rune ${rune}`);
          }
          if (d.id.type !== "Identifier") f.fail(d, "VSV105", "top-level declarations need a simple name");
          const name = d.id.name as string;
          if (rune) {
            runes.add(name);
            continue;
          }
          if (stmt.kind !== "const")
            f.fail(stmt, "VSV103", `top-level \`${stmt.kind}\` without a rune: state is \`let ${name} = $state(...)\`, a constant is \`const\``);
          if (init && isKeymapLiteral(init)) keymaps.add(name);
          else if (init && isStatic(init, allowed)) {
            statics.add(name);
            allowed.add(name);
          }
        }
        continue;
      }
      if (stmt.type === "FunctionDeclaration") {
        if (!stmt.id) f.fail(stmt, "VSV105", "functions need a name");
        fns.add(stmt.id.name);
        continue;
      }
    }

    const rw = new Rewriter(f, runes, new Set());

    // ---- instance script, pass 2: emit ----
    let sawOnButton = false;
    for (const stmt of body) {
      const loc = f.loc(stmt.start);
      switch (stmt.type) {
        case "ImportDeclaration": {
          const kind = this.importKind(f, stmt);
          if (kind === "host") this.hostImports.push({ text: this.rewriteImport(f, stmt), loc });
          else if (kind === "type") this.inlineTypeImport(f, stmt);
          else this.loadChild(f, stmt);
          break;
        }
        case "TSInterfaceDeclaration":
        case "TSTypeAliasDeclaration":
          this.addType(f, stmt.id.name, f.slice(stmt), loc);
          break;
        case "VariableDeclaration": {
          for (const d of stmt.declarations as Node[]) {
            const name = d.id.name as string;
            const init = d.init as Node | null;
            if (runes.has(name)) {
              this.setup.push({ text: this.lowerRune(f, rw, d, init!), loc: f.loc(d.start) });
            } else if (keymaps.has(name) || !statics.has(name)) {
              this.setup.push({ text: rw.rewrite(stmt), loc });
            } else {
              this.hoisted.push({ text: f.slice(stmt), loc });
            }
          }
          break;
        }
        case "FunctionDeclaration":
          this.setup.push({ text: rw.rewrite(stmt), loc });
          break;
        case "ExpressionStatement": {
          const call = stmt.expression as Node;
          const callee = call.type === "CallExpression" && call.callee.type === "Identifier" ? (call.callee.name as string) : null;
          if (callee !== null && (callee === hostOnButton || callee === hostOnAxisDelta)) {
            if (callee === hostOnButton) sawOnButton = true;
            this.setup.push({ text: rw.rewrite(stmt), loc });
            break;
          }
          const rune = call.type === "CallExpression" ? runeName(call.callee) : null;
          if (rune) f.fail(call, "VSV101", `${rune} is outside the Pocket Vapor subset`);
          f.fail(stmt, "VSV105", "only onButton(...) and onAxisDelta(...) may be called at the top level of <script>");
        }
        // falls through (never)
        default:
          f.fail(stmt, "VSV105", `unsupported <script> statement: ${stmt.type}`);
      }
    }
    if (!sawOnButton)
      f.fail(root.instance ? root.instance.start : undefined, "VSV112", "the component never registers onButton(...): every Pocket Vapor app takes input through the host module");

    // ---- template ----
    const childNames = new Set(this.children.keys());
    this.lowerFragment(f, rw, root.fragment.nodes as unknown as Node[], childNames, [], this.template);

    return this.assemble(f);
  }

  // ---- imports ------------------------------------------------------------

  private importKind(f: FileCtx, stmt: Node): "host" | "type" | "child" {
    const spec = stmt.source.value as string;
    const specifiers = stmt.specifiers as Node[];
    const typeOnly = stmt.importKind === "type" || (specifiers.length > 0 && specifiers.every((s) => s.importKind === "type"));
    if (typeOnly) {
      if (!spec.startsWith(".") || !/\.ts$/.test(spec))
        f.fail(stmt, "VSV104", `type imports must name a relative .ts file, got "${spec}"`);
      return "type";
    }
    if (HOST_INPUT.test(spec) || HOST_SCREEN.test(spec)) {
      if (specifiers.some((s) => s.type !== "ImportSpecifier")) f.fail(stmt, "VSV104", "host modules are imported by name");
      return "host";
    }
    if (spec.endsWith(".svelte")) {
      if (specifiers.length !== 1 || specifiers[0].type !== "ImportDefaultSpecifier")
        f.fail(stmt, "VSV104", "a child component is a default import");
      if (!/^[A-Z]/.test(specifiers[0].local.name)) f.fail(specifiers[0], "VSV104", "component names are Capitalized");
      return "child";
    }
    f.fail(stmt, "VSV104", `unsupported import source "${spec}": a Pocket Vapor component imports only the host modules, type-only .ts files and child .svelte components`);
  }

  private rewriteImport(f: FileCtx, stmt: Node): string {
    const spec = stmt.source.value as string;
    if (!this.importBase || !spec.startsWith(".")) return f.slice(stmt);
    const abs = resolve(f.dir, spec);
    let rel = relative(this.importBase, abs).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return f.slice(stmt).replace(spec, rel);
  }

  private inlineTypeImport(f: FileCtx, stmt: Node): void {
    const spec = stmt.source.value as string;
    const abs = resolve(f.dir, spec);
    let text: string;
    try {
      text = this.readFile(abs);
    } catch {
      f.fail(stmt, "VSV104", `cannot read ${spec}`);
    }
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    for (const s of stmt.specifiers as Node[]) {
      const imported = s.imported.name as string;
      if (s.local.name !== imported) f.fail(s, "VSV104", "type imports cannot be aliased");
      const decl = sf.statements.find(
        (d): d is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
          (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) && d.name.text === imported,
      );
      if (!decl) f.fail(s, "VSV104", `${spec} does not declare an interface or type named ${imported}`);
      const line = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
      this.addType(f, imported, decl.getText(sf).replace(/^export\s+/, ""), { file: abs, line }, s);
    }
  }

  private addType(f: FileCtx, name: string, text: string, loc: SourceLoc, at?: Node): void {
    const prev = this.types.get(name);
    if (prev && prev.text !== text) f.fail(at, "VSV104", `type ${name} is declared twice with different bodies`);
    if (!prev) this.types.set(name, { text, loc });
  }

  // ---- runes --------------------------------------------------------------

  private lowerRune(f: FileCtx, rw: Rewriter, d: Node, init: Node): string {
    const name = d.id.name as string;
    const rune = runeName(init.callee)!;
    const arg = init.arguments[0] as Node | undefined;
    if (rune === "$state") {
      if (!arg) f.fail(init, "VSV101", "$state() needs an initial value");
      const typeArgs = (init.typeArguments ?? init.typeParameters) as Node | undefined;
      const annotation = d.id.typeAnnotation?.typeAnnotation as Node | undefined;
      const t = typeArgs?.params?.[0] ? f.slice(typeArgs.params[0]) : annotation ? f.slice(annotation) : "";
      return `const ${name} = ref${t ? `<${t}>` : ""}(${rw.rewrite(arg)});`;
    }
    if (!arg) f.fail(init, "VSV101", `${rune}() needs an expression`);
    if (rune === "$derived") return `const ${name} = computed(() => ${rw.rewrite(arg)});`;
    return `const ${name} = computed(${rw.rewrite(arg)});`; // $derived.by
  }

  // ---- child components ---------------------------------------------------

  private loadChild(f: FileCtx, stmt: Node): void {
    const local = stmt.specifiers[0].local.name as string;
    const spec = stmt.source.value as string;
    const abs = resolve(f.dir, spec);
    if (this.children.has(local)) f.fail(stmt, "VSV104", `component ${local} is imported twice`);
    let source: string;
    try {
      source = this.readFile(abs);
    } catch {
      f.fail(stmt, "VSV104", `cannot read ${spec}`);
    }
    const c: FileCtx = new FileCtx(abs, source);
    const root = c.ast;
    if (root.css) c.fail(root.css as unknown as Node, "VSV111", "<style> is outside the subset");
    if (root.options) c.fail(root.options as unknown as Node, "VSV111", "<svelte:options> is not supported");
    if (root.module) c.fail(root.module as unknown as Node, "VSV105", "child components have no <script module>");

    const localTypes = new Map<string, Node>();
    let propsDecl: Node | null = null;
    for (const s of (root.instance?.content.body ?? []) as Node[]) {
      if (s.type === "ImportDeclaration") {
        if (this.importKind(c, s) !== "type") c.fail(s, "VSV104", "a child component imports types only");
        this.inlineTypeImport(c, s);
      } else if (s.type === "TSInterfaceDeclaration" || s.type === "TSTypeAliasDeclaration") {
        localTypes.set(s.id.name, s);
      } else if (s.type === "VariableDeclaration") {
        const d = s.declarations[0] as Node;
        const rune = d?.init?.type === "CallExpression" ? runeName(d.init.callee) : null;
        if (rune !== "$props" || s.declarations.length !== 1)
          c.fail(s, "VSV105", "a child component's <script> holds only its `let { ... } = $props()` declaration and types");
        if (propsDecl) c.fail(s, "VSV110", "$props() is declared twice");
        propsDecl = d;
      } else c.fail(s, "VSV105", `unsupported statement in a child component: ${s.type}`);
    }
    if (!propsDecl) c.fail(root.instance ? root.instance.start : undefined, "VSV110", "a child component declares its props with `let { a, b }: { a: T; b: U } = $props()`");

    const id = propsDecl.id as Node;
    if (id.type !== "ObjectPattern") c.fail(id, "VSV110", "$props() is destructured: `let { a, b } = $props()`");
    const props: string[] = [];
    for (const p of id.properties as Node[]) {
      if (p.type !== "Property" || p.computed || p.key.type !== "Identifier" || p.value.type !== "Identifier" || p.key.name !== p.value.name)
        c.fail(p, "VSV110", "props are plain names without defaults, renames or rest (v1)");
      props.push(p.key.name);
    }
    const ann = id.typeAnnotation?.typeAnnotation as Node | undefined;
    let typeText: string;
    if (!ann) c.fail(id, "VSV110", "$props() needs a type: `let { a }: { a: number } = $props()`");
    if (ann.type === "TSTypeLiteral") typeText = c.slice(ann);
    else if (ann.type === "TSTypeReference" && ann.typeName.type === "Identifier" && localTypes.has(ann.typeName.name)) {
      const decl = localTypes.get(ann.typeName.name)!;
      const bodyNode = decl.type === "TSInterfaceDeclaration" ? (decl.body as Node) : (decl.typeAnnotation as Node);
      typeText = c.slice(bodyNode);
      localTypes.delete(ann.typeName.name);
    } else c.fail(ann, "VSV110", "the props type must be an inline `{ ... }` literal or a same-file interface");
    for (const [name, decl] of localTypes) this.addType(c, name, c.slice(decl), c.loc(decl.start));

    const rw = new Rewriter(c, new Set(), new Set(props));
    const nodes = this.cleanNodes(root.fragment.nodes as unknown as Node[]);
    const rows = nodes.filter((n) => n.type !== "Text" || NOT_WS.test(n.data));
    if (rows.length !== 1 || rows[0].type !== "RegularElement" || rows[0].name !== "row")
      c.fail(
        rows[1] ?? rows[0] ?? (root.fragment.nodes[0] as unknown as Node | undefined),
        "VSV105",
        "a child component renders exactly one <row> (components cannot nest, v1)",
      );
    const row = this.lowerRow(c, rw, rows[0], []);

    this.children.set(local, { name: local, file: abs, props });
    this.childFiles.push(abs);
    this.componentFns.push({ text: `function ${local}(props: ${typeText}) {`, loc: c.loc(propsDecl.start) });
    this.componentFns.push({ text: "  return (", loc: null });
    this.componentFns.push({ text: indent(row.text, 4), loc: row.loc });
    this.componentFns.push({ text: "  );\n}", loc: null });
  }

  // ---- template -----------------------------------------------------------

  /** Svelte's clean_nodes for one fragment; Text nodes are copied, not mutated. */
  private cleanNodes(nodes: Node[]): Node[] {
    const regular: Node[] = [];
    for (const n of nodes) {
      if (n.type === "Comment") continue;
      regular.push(n.type === "Text" ? { ...n } : n);
    }
    while (regular[0]?.type === "Text" && !NOT_WS.test(regular[0].data)) regular.shift();
    if (regular[0]?.type === "Text") trimStart(regular[0], "");
    while (regular.length && regular[regular.length - 1].type === "Text" && !NOT_WS.test(regular[regular.length - 1].data))
      regular.pop();
    if (regular.length && regular[regular.length - 1].type === "Text")
      regular[regular.length - 1].data = regular[regular.length - 1].data.replace(ENDS_WS, "");
    const out: Node[] = [];
    for (let i = 0; i < regular.length; i++) {
      const prev = regular[i - 1];
      const node = regular[i];
      const next = regular[i + 1];
      if (node.type !== "Text") {
        out.push(node);
        continue;
      }
      if (prev?.type !== "ExpressionTag") {
        const prevWs = prev?.type === "Text" && ENDS_WS.test(prev.data);
        trimStart(node, prevWs ? "" : " ");
      }
      if (next?.type !== "ExpressionTag") node.data = node.data.replace(ENDS_WS, " ");
      if (node.data) out.push(node);
    }
    return out;
  }

  private lowerFragment(
    f: FileCtx,
    rw: Rewriter,
    nodes: Node[],
    childNames: ReadonlySet<string>,
    locals: readonly string[][],
    out: Chunk[],
  ): void {
    for (const node of this.cleanNodes(nodes)) {
      switch (node.type) {
        case "Text":
          if (NOT_WS.test(node.data)) f.fail(node, "VSV107", "text at the top level is not painted: put it in a <row>");
          break;
        case "RegularElement":
        case "Component":
          out.push(this.lowerRenderable(f, rw, node, childNames, locals));
          break;
        case "IfBlock":
          this.lowerIf(f, rw, node, childNames, locals, [], out);
          break;
        case "EachBlock":
          this.lowerEach(f, rw, node, childNames, locals, out);
          break;
        default:
          f.fail(node, "VSV105", `${describe(node)} is outside the subset: a template holds <row>s, child components, {#if} and {#each}`);
      }
    }
  }

  private lowerRenderable(f: FileCtx, rw: Rewriter, node: Node, childNames: ReadonlySet<string>, locals: readonly string[][]): Chunk {
    if (node.type === "RegularElement") {
      if (node.name !== "row") f.fail(node, "VSV105", `<${node.name}> is not a host element: the only intrinsic is <row>`);
      return this.lowerRow(f, rw, node, locals);
    }
    const child = this.children.get(node.name);
    if (!child || !childNames.has(node.name)) f.fail(node, "VSV113", `<${node.name}> is not an imported .svelte component`);
    const attrs = this.lowerAttributes(f, rw, node, locals, null);
    const inner = this.cleanNodes(node.fragment.nodes as Node[]);
    if (inner.length > 0) f.fail(inner[0], "VSV105", `<${node.name}> takes props only: children and snippets are outside the subset`);
    return { text: `<${node.name}${attrs} />`, loc: f.loc(node.start) };
  }

  private lowerRow(f: FileCtx, rw: Rewriter, node: Node, locals: readonly string[][]): Chunk {
    const attrs = this.lowerAttributes(f, rw, node, locals, new Set(["y", "x", "class"]));
    const parts: string[] = [];
    for (const child of this.cleanNodes(node.fragment.nodes as Node[])) {
      if (child.type === "Text") {
        if (child.data.includes("\n"))
          f.fail(child, "VSV107", "row text spans lines: a newline would paint as `?`; keep a row's text on one line");
        parts.push(`{${JSON.stringify(child.data)}}`);
      } else if (child.type === "ExpressionTag") {
        parts.push(`{${rw.rewrite(child.expression, locals)}}`);
      } else f.fail(child, "VSV107", `${describe(child)} inside a <row>: rows hold text and {expressions} only`);
    }
    return { text: `<row${attrs}>${parts.join("")}</row>`, loc: f.loc(node.start) };
  }

  private lowerAttributes(
    f: FileCtx,
    rw: Rewriter,
    node: Node,
    locals: readonly string[][],
    allowed: ReadonlySet<string> | null,
  ): string {
    let out = "";
    for (const attr of node.attributes as Node[]) {
      if (attr.type !== "Attribute")
        f.fail(attr, "VSV106", `${describe(attr)} on <${node.name}>: only plain attributes are supported (no directives, spreads, events or attachments)`);
      const name = attr.name as string;
      if (allowed && !allowed.has(name)) f.fail(attr, "VSV106", `unknown <row> attribute ${name}: rows take y, x and class`);
      const value = attr.value;
      if (value === true) f.fail(attr, "VSV106", `attribute ${name} needs a value`);
      if (!Array.isArray(value)) {
        out += ` ${name}={${rw.rewrite(value.expression, locals)}}`;
        continue;
      }
      if (value.length !== 1 || value[0].type !== "Text")
        f.fail(attr, "VSV106", `attribute ${name} mixes text and {expressions}: write one literal or one {expression}`);
      const text = value[0].data as string;
      out += /["\\\n]/.test(text) ? ` ${name}={${JSON.stringify(text)}}` : ` ${name}="${text}"`;
    }
    return out;
  }

  private lowerIf(
    f: FileCtx,
    rw: Rewriter,
    block: Node,
    childNames: ReadonlySet<string>,
    locals: readonly string[][],
    negated: readonly string[],
    out: Chunk[],
  ): void {
    const cond = rw.rewrite(block.test, locals);
    const guard = [...negated.map((n) => `!(${n})`), simple(block.test) ? cond : `(${cond})`].join(" && ");
    for (const child of this.cleanNodes(block.consequent.nodes as Node[])) {
      const jsx = this.branchChild(f, rw, child, childNames, locals);
      out.push({ text: `{${guard} ? ${jsx.text} : null}`, loc: jsx.loc });
    }
    if (!block.alternate) return;
    const alt = this.cleanNodes(block.alternate.nodes as Node[]);
    if (alt.length === 1 && alt[0].type === "IfBlock" && alt[0].elseif) {
      this.lowerIf(f, rw, alt[0], childNames, locals, [...negated, cond], out);
      return;
    }
    const elseGuard = [...negated, cond].map((n) => `!(${n})`).join(" && ");
    for (const child of alt) {
      const jsx = this.branchChild(f, rw, child, childNames, locals);
      out.push({ text: `{${elseGuard} ? ${jsx.text} : null}`, loc: jsx.loc });
    }
  }

  private branchChild(f: FileCtx, rw: Rewriter, child: Node, childNames: ReadonlySet<string>, locals: readonly string[][]): Chunk {
    if (child.type === "Text" && !NOT_WS.test(child.data)) return { text: "", loc: null };
    if (child.type !== "RegularElement" && child.type !== "Component")
      f.fail(child, "VSV107", `${describe(child)} inside a block: {#if} and {#each} bodies hold <row>s and components only`);
    return this.lowerRenderable(f, rw, child, childNames, locals);
  }

  private lowerEach(
    f: FileCtx,
    rw: Rewriter,
    block: Node,
    childNames: ReadonlySet<string>,
    locals: readonly string[][],
    out: Chunk[],
  ): void {
    const ctx = block.context as Node | null;
    if (!ctx || ctx.type !== "Identifier") f.fail(block, "VSV108", "{#each list as item, i}: the item is a plain name");
    const item = ctx.name as string;
    const index = (block.index as string | undefined) ?? "_i";
    rw.checkShadow([item, index], block);
    const list = rw.rewrite(block.expression, locals);
    const inner = [...locals, [item, index]];
    const bodyNodes = this.cleanNodes(block.body.nodes as Node[]).filter((n) => n.type !== "Text" || NOT_WS.test(n.data));
    if (bodyNodes.length !== 1) f.fail(block, "VSV105", "an {#each} body renders exactly one <row> or component per item");
    const jsx = this.branchChild(f, rw, bodyNodes[0], childNames, inner);
    out.push({ text: `{${list}.map((${item}, ${index}) => (`, loc: f.loc(block.start) });
    out.push({ text: indent(jsx.text, 2), loc: jsx.loc });
    out.push({ text: "))}", loc: null });
    if (block.fallback) {
      for (const child of this.cleanNodes(block.fallback.nodes as Node[])) {
        const fb = this.branchChild(f, rw, child, childNames, locals);
        if (fb.text) out.push({ text: `{${list}.length === 0 ? ${fb.text} : null}`, loc: fb.loc });
      }
    }
  }

  // ---- assembly -----------------------------------------------------------

  private assemble(f: FileCtx): SvelteLowering {
    const chunks: Chunk[] = [];
    chunks.push({ text: `// generated by vapor/compiler/svelte.ts from ${f.file} — do not edit`, loc: null });
    chunks.push({ text: 'import { computed, ref } from "vue";', loc: null });
    chunks.push(...this.hostImports);
    chunks.push({ text: "", loc: null });
    for (const t of this.types.values()) chunks.push(t);
    chunks.push(...this.moduleScript);
    chunks.push(...this.hoisted);
    if (this.componentFns.length) chunks.push({ text: "", loc: null });
    chunks.push(...this.componentFns);
    chunks.push({ text: "", loc: null });
    chunks.push({ text: "export default () => {", loc: f.ast.instance ? f.loc(f.ast.instance.start) : null });
    for (const s of this.setup) chunks.push({ text: indent(s.text, 2), loc: s.loc });
    chunks.push({ text: "  return (\n    <>", loc: null });
    for (const t of this.template) if (t.text) chunks.push({ text: indent(t.text, 6), loc: t.loc });
    chunks.push({ text: "    </>\n  );\n};", loc: null });

    const out: string[] = [];
    const lines: (SourceLoc | null)[] = [];
    for (const c of chunks) {
      const parts = c.text.split("\n");
      parts.forEach((p, k) => {
        out.push(p);
        lines.push(c.loc ? { file: c.loc.file, line: c.loc.line + k } : null);
      });
    }
    return { tsx: `${out.join("\n")}\n`, lines, children: [...this.childFiles] };
  }
}

function describe(node: Node): string {
  switch (node.type) {
    case "ConstTag":
      return "{@const}";
    case "AwaitBlock":
      return "{#await}";
    case "KeyBlock":
      return "{#key}";
    case "SnippetBlock":
      return "{#snippet}";
    case "RenderTag":
      return "{@render}";
    case "HtmlTag":
      return "{@html}";
    case "DebugTag":
      return "{@debug}";
    case "AttachTag":
      return "{@attach}";
    case "BindDirective":
      return "bind:";
    case "OnDirective":
      return "on:";
    case "ClassDirective":
      return "class:";
    case "StyleDirective":
      return "style:";
    case "UseDirective":
      return "use:";
    case "TransitionDirective":
      return "transition:";
    case "AnimateDirective":
      return "animate:";
    case "LetDirective":
      return "let:";
    case "SpreadAttribute":
      return "{...spread}";
    case "Attribute":
      return `attribute ${node.name}`;
    case "ExpressionTag":
      return "an {expression}";
    case "Text":
      return "text";
    default:
      return node.name ? `<${node.name}>` : node.type;
  }
}

/** An expression that needs no parentheses as a ternary condition. */
function simple(node: Node): boolean {
  return (
    node.type === "Identifier" ||
    node.type === "MemberExpression" ||
    node.type === "CallExpression" ||
    node.type === "Literal" ||
    node.type === "UnaryExpression" ||
    node.type === "BinaryExpression"
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Lower a .svelte component to Pocket Vapor TSX (no compilation). */
export function lowerSvelte(fileName: string, source: string, opts: LowerOptions = {}): SvelteLowering {
  return new SvelteLowerer(opts).lower(fileName, source);
}

export interface CompiledSvelteApp extends CompiledApp {
  /** the generated TSX the back end compiled */
  tsx: string;
  lowering: SvelteLowering;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lower and compile. Diagnostics and errors from the back end name the
 * generated file; they are rewritten to the .svelte location through the
 * line map before they leave this function.
 */
export function compileSvelteApp(
  fileName: string,
  source: string,
  title = "VAPOR",
  targetName: VaporTargetName = "gba",
  options: CompileOptions & LowerOptions = {},
): CompiledSvelteApp {
  const lowering = lowerSvelte(fileName, source, options);
  const genName = fileName.replace(/\.svelte$/, ".vapor.tsx");
  const re = new RegExp(`${escapeRegExp(genName)}(?::(\\d+):(\\d+))?`, "g");
  const remap = (text: string): string =>
    text.replace(re, (_m, l?: string, c?: string) => {
      if (l === undefined) return fileName;
      const loc = lowering.lines[Number(l) - 1];
      return loc ? `${loc.file}:${loc.line}:${c}` : `${fileName}:1:1`;
    });
  try {
    const app = compileVaporApp(genName, lowering.tsx, title, targetName, { strict: options.strict });
    return { ...app, diagnostics: app.diagnostics.map(remap), tsx: lowering.tsx, lowering };
  } catch (e) {
    if (e instanceof Error) e.message = remap(e.message);
    throw e;
  }
}
