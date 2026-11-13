// Minimal defineTool + schema compiler (no external dependency).
//
// Same approach as dsh-project-memory/memory-plugin.js: the plugin never imports
// `@deepseek-ai/dsh-tools`, so a desktop profile without that optional peer still
// activates. Pure functions — no ctx, no I/O.

/** Recursively turn one schema-DSL node into standard JSON Schema (`required: true` hoisted). */
export function schemaSpecToJsonSchema(spec) {
  const out = {};
  for (const key of Object.keys(spec)) {
    if (key === 'properties' || key === 'items' || key === 'required') continue;
    out[key] = spec[key];
  }
  if (spec.properties !== undefined) {
    const props = {};
    const required = [];
    for (const prop of Object.keys(spec.properties)) {
      const sub = spec.properties[prop];
      props[prop] = schemaSpecToJsonSchema(sub);
      if (sub.required === true) required.push(prop);
    }
    out.properties = props;
    if (required.length > 0) out.required = required;
  }
  if (spec.items !== undefined) out.items = schemaSpecToJsonSchema(spec.items);
  return out;
}

/** parameters = { propName: propSchema } -> open object root schema. */
export function paramsSpecToJsonSchema(spec = {}) {
  const properties = {};
  const required = [];
  for (const prop of Object.keys(spec)) {
    const sub = spec[prop];
    properties[prop] = schemaSpecToJsonSchema(sub);
    if (sub.required === true) required.push(prop);
  }
  const out = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

/** Light validation: required keys, basic types and `enum`. */
export function validateArgs(parameters, args) {
  const errors = [];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return ['expected an object of arguments'];
  }
  for (const key of parameters.required ?? []) {
    if (args[key] === undefined) errors.push(`missing required argument "${key}"`);
  }
  const props = parameters.properties ?? {};
  for (const key of Object.keys(props)) {
    const value = args[key];
    if (value === undefined) continue;
    const t = props[key].type;
    if (t === 'string' && typeof value !== 'string') errors.push(`"${key}" must be a string`);
    else if (t === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`"${key}" must be a number`);
    else if (t === 'boolean' && typeof value !== 'boolean') errors.push(`"${key}" must be a boolean`);
    else if (t === 'array' && !Array.isArray(value)) errors.push(`"${key}" must be an array`);
    else if (t === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      errors.push(`"${key}" must be an object`);
    }
    if (Array.isArray(props[key].enum) && !props[key].enum.includes(value)) {
      errors.push(`"${key}" must be one of ${props[key].enum.join(' | ')}`);
    }
  }
  return errors;
}

/** Equivalent of `@deepseek-ai/dsh-tools` defineTool: compile schema + validate, then execute. */
export function defineTool(options) {
  const { parameters: paramSpec, output, execute: userExecute, timeoutMs, ...rest } = options;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }
  const parameters = paramsSpecToJsonSchema(paramSpec);
  const { schema, render, ...outputRest } = output;
  return {
    ...rest,
    parameters,
    output: {
      ...outputRest,
      schema: schemaSpecToJsonSchema(schema),
      render: (args, value) => render(args, value),
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validateArgs(parameters, args ?? {});
      if (violations.length > 0) throw new Error(`Invalid arguments for ${options.name}: ${violations.join('; ')}`);
      return userExecute(args ?? {}, exec);
    },
  };
}
