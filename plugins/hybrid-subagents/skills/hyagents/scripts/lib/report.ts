import { existsSync, readFileSync, statSync } from "node:fs";
import type { RoleName } from "./config.ts";

export const REVIEW_SCHEMA_URL = new URL("../../schemas/review.schema.json", import.meta.url);

type Schema = {
  type?: string; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>;
  additionalProperties?: boolean; items?: Schema; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
};

/** Enough JSON Schema for the bundled review schema; no runtime dependencies. */
export function schemaErrors(value: unknown, schema: Schema, at = "$"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
  if (type && !(type === actual || (type === "number" && actual === "integer"))) return [`${at} must be ${type}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} must not be shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at} must not be longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items!, `${at}[${index}]`)));
  if (actual === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) errors.push(`${at}.${key} is required`);
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...schemaErrors(item, property, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`);
    }
  }
  return errors;
}

let reviewSchema: Schema | undefined;
export function loadReviewSchema(): Schema {
  return reviewSchema ??= JSON.parse(readFileSync(REVIEW_SCHEMA_URL, "utf8"));
}

export function reviewErrors(value: unknown): string[] {
  const errors = schemaErrors(value, loadReviewSchema());
  if (errors.length) return errors;
  (value as { findings: { line_start: number; line_end: number }[] }).findings.forEach((finding, index) => {
    if (finding.line_end < finding.line_start) errors.push(`$.findings[${index}].line_end must be >= line_start`);
  });
  return errors;
}

export type ReportCheck = { status: "missing" } | { status: "ok" } | { status: "invalid"; errors: string[] };

export function checkReport(role: RoleName, file: string): ReportCheck {
  if (!existsSync(file) || statSync(file).size === 0) return { status: "missing" };
  if (role !== "reviewer") return { status: "ok" };
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { return { status: "invalid", errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
  const errors = reviewErrors(value);
  return errors.length ? { status: "invalid", errors } : { status: "ok" };
}
