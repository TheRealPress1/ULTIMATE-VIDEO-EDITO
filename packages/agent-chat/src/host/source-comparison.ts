/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { parse } from "@babel/parser";

// These are the same viewing-only props excluded by the canvas undo stack.
// Only literal values on intrinsic composition tags are ignored. An arbitrary
// expression could affect composition code, so it remains a conflict.
const VIEW_PROPS = new Set(["selected", "active", "camera", "expanded", "clipHeight", "timeline", "playhead"]);
const TAGS = new Set(["stage", "scene", "group", "video", "audio", "image", "text", "rect", "ellipse", "path", "line", "polygon", "captions", "sequence", "adjustmentLayer"]);
type AstNode = { type: string; start?: number | null; end?: number | null; [key: string]: unknown };
const node = (value: unknown): value is AstNode => !!value && typeof value === "object" && typeof (value as AstNode).type === "string";

function literal(value: unknown): boolean {
  if (!node(value)) return false;
  if (["NumericLiteral", "StringLiteral", "BooleanLiteral", "NullLiteral"].includes(value.type)) return true;
  if (value.type === "UnaryExpression" && ["-", "+"].includes(String(value.operator))) return node(value.argument) && value.argument.type === "NumericLiteral";
  if (value.type === "ArrayExpression") return Array.isArray(value.elements) && value.elements.every(literal);
  if (value.type === "ObjectExpression") return Array.isArray(value.properties) && value.properties.every((property) =>
    node(property) && property.type === "ObjectProperty" && !property.computed && !property.method && literal(property.value));
  return false;
}

/** Normalize JSX opening tags only; text, strings, comments and code stay exact. */
export function comparableSource(path: string, source: string): string {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return source;
  try {
    const ast = parse(source, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
    const replacements: { start: number; end: number; text: string }[] = [];
    const visit = (value: unknown) => {
      if (!node(value)) return;
      if (value.type === "JSXOpeningElement" && node(value.name) && value.name.type === "JSXIdentifier" && TAGS.has(String(value.name.name)) && Array.isArray(value.attributes)) {
        const attributes = value.attributes.filter((attribute) => {
          if (!node(attribute) || attribute.type !== "JSXAttribute" || !node(attribute.name) || !VIEW_PROPS.has(String(attribute.name.name))) return true;
          return attribute.value !== null && !(node(attribute.value) && (attribute.value.type === "StringLiteral" || (attribute.value.type === "JSXExpressionContainer" && literal(attribute.value.expression))));
        });
        const raw = attributes.map((attribute) => {
          const attr = attribute as AstNode;
          return source.slice(attr.start!, attr.end!);
        });
        replacements.push({ start: value.start!, end: value.end!, text: `<${value.name.name}${raw.length ? " " + raw.join(" ") : ""}${value.selfClosing ? " />" : ">"}` });
      }
      for (const [key, child] of Object.entries(value)) {
        if (["loc", "comments", "tokens"].includes(key)) continue;
        if (Array.isArray(child)) child.forEach(visit);
        else if (node(child)) visit(child);
      }
    };
    visit(ast);
    let result = source;
    // Nested JSX inside an attribute is kept raw by its parent. Applying only
    // outermost replacements avoids offsets overlapping each other.
    const outer = replacements.filter((item) => !replacements.some((other) => other !== item && other.start < item.start && other.end >= item.end));
    for (const replacement of outer.sort((a, b) => b.start - a.start)) result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
    return result;
  } catch { return source; } // Unparseable source always uses exact comparison.
}
