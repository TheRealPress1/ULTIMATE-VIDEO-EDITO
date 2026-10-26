/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Pure JSX planning for selective version restoration. It never evaluates project code. */
import { Project, SyntaxKind, ts } from "ts-morph";
import { isCompositionTag } from "@diffusionstudio/jsx";
import type { JsxAttribute, JsxElement, JsxOpeningElement, JsxSelfClosingElement, Node, SourceFile } from "ts-morph";

type Tag = JsxOpeningElement | JsxSelfClosingElement;
type Element = JsxElement | JsxSelfClosingElement;
export type LayerDependency = { path: string; tag: string };
export interface VersionLayerSource {
  file: string;
  id: string;
  tag: string;
  name: string;
  status: "missing" | "changed" | "unchanged";
  canRestore: boolean;
  reason?: string;
  savedSource: string;
  currentSource?: string;
  dependencies: LayerDependency[];
}

const LAYERS = new Set(["scene", "group", "rect", "ellipse", "polygon", "path", "video", "image", "audio", "text", "sequence", "captions", "adjustmentLayer"]);
const UNSUPPORTED = new Set(["htmlPaint", "html", "shaderPaint", "surfacePaint", "surface"]);
const canonical = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);
const nameOf = (tag: Tag): string => tag.getTagNameNode().getText();
const attribute = (tag: Tag, name: string): JsxAttribute | undefined => tag.getAttribute(name)?.asKind(SyntaxKind.JsxAttribute);
const stringValue = (node: Node | undefined): string | undefined => {
  if (node?.isKind(SyntaxKind.StringLiteral)) return node.getLiteralValue();
  if (node?.isKind(SyntaxKind.JsxExpression)) return stringValue(node.getExpression());
  return undefined;
};
const valueOf = (tag: Tag, name: string): string | undefined => stringValue(attribute(tag, name)?.getInitializer());
const idOf = (tag: Tag): string | undefined => valueOf(tag, "id");
const elementOf = (tag: Tag): Element => tag.isKind(SyntaxKind.JsxOpeningElement) ? tag.getParentOrThrow() : tag;
const sourceTagCache = new WeakMap<SourceFile, Tag[]>();
const tagIdCache = new WeakMap<Tag[], Map<string, Tag[]>>();
function sourceTags(source: SourceFile): Tag[] {
  let all = sourceTagCache.get(source);
  if (!all) { all = tags(source); sourceTagCache.set(source, all); }
  return all;
}
function byId(all: Tag[]): Map<string, Tag[]> {
  let index = tagIdCache.get(all);
  if (!index) {
    index = new Map();
    for (const tag of all) { const id = idOf(tag); if (id) index.set(id, [...(index.get(id) ?? []), tag]); }
    tagIdCache.set(all, index);
  }
  return index;
}

function tags(node: Node): Tag[] {
  const result: Tag[] = [];
  const visit = (child: Node): void => {
    if (child.isKind(SyntaxKind.JsxOpeningElement) || child.isKind(SyntaxKind.JsxSelfClosingElement)) result.push(child);
  };
  visit(node);
  node.forEachDescendant(visit);
  return result;
}

function parse(text: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, noResolve: true } });
  const source = project.createSourceFile("version.tsx", text);
  const parsed = source.compilerNode as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
  if (parsed.parseDiagnostics.length) throw new Error("This source has syntax errors. Restore the whole version instead.");
  return source;
}

function literal(node: Node | undefined): boolean {
  if (!node) return true;
  if ([SyntaxKind.StringLiteral, SyntaxKind.NumericLiteral, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.NoSubstitutionTemplateLiteral].includes(node.getKind())) return true;
  if (node.isKind(SyntaxKind.ParenthesizedExpression)) return literal(node.getExpression());
  if (node.isKind(SyntaxKind.PrefixUnaryExpression)) return [SyntaxKind.MinusToken, SyntaxKind.PlusToken].includes(node.getOperatorToken()) && node.getOperand().isKind(SyntaxKind.NumericLiteral);
  if (node.isKind(SyntaxKind.ArrayLiteralExpression)) return node.getElements().every(literal);
  if (node.isKind(SyntaxKind.ObjectLiteralExpression)) return node.getProperties().every((entry) => {
    const property = entry.asKind(SyntaxKind.PropertyAssignment);
    return !!property && !property.getNameNode().isKind(SyntaxKind.ComputedPropertyName) && literal(property.getInitializer());
  });
  return false;
}

function staticDependencies(element: Element): LayerDependency[] {
  const dependencies: LayerDependency[] = [];
  const subtree = tags(element);
  if (subtree.length > 2000) throw new Error("This layer contains more than 2,000 elements. Restore the whole version instead.");
  for (const tag of subtree) {
    const name = canonical(nameOf(tag));
    if (nameOf(tag) !== name || !isCompositionTag(nameOf(tag)) || UNSUPPORTED.has(name)) throw new Error("This layer uses custom rendering. Restore the whole version instead.");
    for (const attr of tag.getAttributes()) {
      if (!attr.isKind(SyntaxKind.JsxAttribute)) throw new Error("This layer uses spread properties. Restore the whole version instead.");
      const initializer = attr.getInitializer();
      if (initializer?.isKind(SyntaxKind.JsxExpression) && !literal(initializer.getExpression())) throw new Error("This layer depends on calculated properties. Restore the whole version instead.");
    }
    const src = attribute(tag, "src");
    if (src) {
      const path = stringValue(src.getInitializer());
      if (!path) throw new Error("This layer has a dynamic media link. Restore the whole version instead.");
      dependencies.push({ path, tag: name });
    }
  }
  for (const expression of element.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
    if (!literal(expression.getExpression())) throw new Error("This layer depends on calculated content. Restore the whole version instead.");
  }
  return dependencies;
}

function unique(all: Tag[], id: string): Tag | undefined {
  const found = byId(all).get(id) ?? [];
  if (found.length > 1) throw new Error(`The layer ID ${id} is duplicated. Restore the whole version instead.`);
  return found[0];
}

function directParent(tag: Tag): Tag | undefined {
  const parent = elementOf(tag).getParent();
  return parent?.isKind(SyntaxKind.JsxElement) ? parent.getOpeningElement() : undefined;
}

function parentInCurrent(saved: Tag, current: Tag[]): Tag {
  const parent = directParent(saved);
  if (!parent) throw new Error("This layer is inside a dynamic expression or has no recoverable parent. Restore the whole version instead.");
  const id = idOf(parent);
  const target = id ? unique(current, id) : current.filter((tag) => canonical(nameOf(tag)) === "stage" && !directParent(tag));
  const found = Array.isArray(target) ? target.length === 1 ? target[0] : undefined : target;
  if (!found || canonical(nameOf(found)) !== canonical(nameOf(parent))) throw new Error("The saved parent is missing or ambiguous. Restore its scene or the whole version instead.");
  if (!id && canonical(nameOf(parent)) !== "stage") throw new Error("The saved parent has no stable ID. Restore its scene or the whole version instead.");
  return found;
}

type Plan = { saved: SourceFile; current: SourceFile; oldTag: Tag; currentTag?: Tag; parent?: Tag; dependencies: LayerDependency[] };
function assertStaticLocation(tag: Tag): void {
  if (elementOf(tag).getAncestors().some((ancestor) => ancestor.isKind(SyntaxKind.JsxExpression))) throw new Error("This layer is inside a dynamic expression. Restore the whole version instead.");
  // An intrinsic layer in a reusable function can still render several times.
  // Only a direct intrinsic ancestry to the authored stage is unambiguous.
  let parent = elementOf(tag).getParent();
  while (parent?.isKind(SyntaxKind.JsxElement)) {
    const name = nameOf(parent.getOpeningElement());
    if (name !== canonical(name) || !isCompositionTag(name)) break;
    if (name === "stage") return;
    parent = parent.getParent();
  }
  if (canonical(nameOf(tag)) === "stage" && !directParent(tag)) return;
  throw new Error("This layer is not directly inside an authored stage. Restore the whole version instead.");
}

function planParsed(saved: SourceFile, current: SourceFile, id: string): Plan {
  const savedTags = sourceTags(saved);
  const currentTags = sourceTags(current);
  const oldTag = unique(savedTags, id);
  if (!oldTag || !LAYERS.has(canonical(nameOf(oldTag)))) throw new Error("The saved layer could not be identified.");
  assertStaticLocation(oldTag);
  const dependencies = staticDependencies(elementOf(oldTag));
  const currentTag = unique(currentTags, id);
  // Replacing a node inside a loop could affect multiple rendered layers.
  if (currentTag) {
    assertStaticLocation(currentTag);
    if (!directParent(currentTag)) throw new Error("The current layer has no recoverable parent. Restore the whole version instead.");
  }
  const parent = currentTag ? undefined : parentInCurrent(oldTag, currentTags);
  if (parent) assertStaticLocation(parent);
  const inside = currentTag ? new Set(tags(elementOf(currentTag))) : new Set<Tag>();
  const seen = new Set<string>();
  for (const descendant of tags(elementOf(oldTag))) {
    const childId = idOf(descendant);
    if (!childId) continue;
    if (seen.has(childId) || byId(savedTags).get(childId)?.length !== 1 || (byId(currentTags).get(childId) ?? []).some((candidate) => !inside.has(candidate))) {
      throw new Error(`The layer ID ${childId} conflicts with another layer. Restore the whole version instead.`);
    }
    seen.add(childId);
  }
  return { saved, current, oldTag, currentTag, parent, dependencies };
}

function plan(savedText: string, currentText: string, id: string): Plan {
  return planParsed(parse(savedText), parse(currentText), id);
}

export function inspectSourceLayers(file: string, savedText: string, currentText: string | undefined): VersionLayerSource[] {
  let saved: SourceFile;
  try { saved = parse(savedText); } catch { return []; }
  let current: SourceFile | undefined;
  try { if (currentText !== undefined) current = parse(currentText); } catch { /* Each row explains why restoring is unavailable. */ }
  const all = sourceTags(saved).filter((tag) => LAYERS.has(canonical(nameOf(tag))) && !!idOf(tag)).slice(0, 500);
  const currentTags = current ? sourceTags(current) : [];
  return all.map((tag) => {
    const id = idOf(tag)!;
    const savedSource = elementOf(tag).getText();
    const matches = byId(currentTags).get(id) ?? [];
    const currentSource = matches.length === 1 ? elementOf(matches[0]).getText() : undefined;
    const row: VersionLayerSource = {
      file, id, tag: canonical(nameOf(tag)), name: valueOf(tag, "name") || `${canonical(nameOf(tag))} · ${id}`,
      status: currentSource === undefined ? "missing" : currentSource === savedSource ? "unchanged" : "changed",
      savedSource, currentSource, canRestore: false, dependencies: [],
    };
    try {
      if (currentText === undefined) throw new Error("This source file is missing. Restore the whole version instead.");
      if (!current) throw new Error("The current source has syntax errors. Restore the whole version instead.");
      row.dependencies = planParsed(saved, current, id).dependencies;
      row.canRestore = true;
    } catch (error) { row.reason = (error as Error).message; }
    return row;
  });
}

/** Restores one subtree using text ranges, so every unrelated source byte stays intact. */
export function restoreLayerSource(savedText: string, currentText: string, id: string, remap = new Map<string, string>()): { source: string; dependencies: LayerDependency[] } {
  const result = plan(savedText, currentText, id);
  for (const tag of tags(elementOf(result.oldTag))) {
    const path = valueOf(tag, "src");
    if (path && remap.has(path) && remap.get(path) !== path) attribute(tag, "src")!.setInitializer(`{${JSON.stringify(remap.get(path))}}`);
  }
  const restored = elementOf(result.oldTag).getText();
  if (result.currentTag) {
    const target = elementOf(result.currentTag);
    return { source: currentText.slice(0, target.getStart()) + restored + currentText.slice(target.getEnd()), dependencies: result.dependencies };
  }
  const parent = elementOf(result.parent!);
  if (parent.isKind(SyntaxKind.JsxSelfClosingElement)) {
    const replacement = parent.getText().replace(/\s*\/>$/, ">") + `\n${restored}\n</${nameOf(result.parent!)}>`;
    return { source: currentText.slice(0, parent.getStart()) + replacement + currentText.slice(parent.getEnd()), dependencies: result.dependencies };
  }
  // The nearest surviving following sibling keeps the layer's stacking order.
  const savedParent = elementOf(directParent(result.oldTag)!);
  const savedSiblings = savedParent.isKind(SyntaxKind.JsxElement) ? savedParent.getJsxChildren() : [];
  let following = false;
  let before: Element | undefined;
  for (const sibling of savedSiblings) {
    if (sibling === elementOf(result.oldTag)) { following = true; continue; }
    if (!following) continue;
    const siblingTag = sibling.isKind(SyntaxKind.JsxElement) ? sibling.getOpeningElement() : sibling.asKind(SyntaxKind.JsxSelfClosingElement);
    const siblingId = siblingTag && idOf(siblingTag);
    if (!siblingId) continue;
    const candidate = unique(sourceTags(result.current), siblingId);
    if (candidate && directParent(candidate) === result.parent) { before = elementOf(candidate); break; }
  }
  const offset = before?.getStart() ?? parent.getClosingElement().getStart();
  return { source: currentText.slice(0, offset) + `${restored}\n` + currentText.slice(offset), dependencies: result.dependencies };
}
