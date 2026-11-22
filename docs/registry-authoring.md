# Defining endpoint operations

F04 provides registration, input validation, schema generation and independent parity checks. Endpoint families T01–T12 populate the production catalog, which now holds all 133 inventory endpoints. F08 serves it over MCP, and the CLI lists exactly these tools.

## Define one entry per endpoint

Use `defineOperation` with the exact REST token, method, route, family and canonical public driver binding. The tool name is derived as `testrail_<token>`. Include these items:

- the input schema;
- the explicit argument map;
- the outer response schema;
- the advisory entity schema;
- the paging/file capabilities;
- the TestRail effect;
- the driver retry policy.

Required route arguments must exist in every input branch. They must have mappings in every call mode. Root and query objects must be closed. File and `_mcp` fields are reserved for tools supporting those capabilities. `createRegistry` rejects duplicate literal names at compile time. It rejects duplicate dynamic names/routes at runtime, then sorts discovery by tool name.

Declare execution modes with `pagination: (bind) => ({ ... })`. Use `bind(binding, callback)` for each call. Registration supplies this typed builder around its finalized input contract. The callback receives these items:

- the actual bound public method, including overloads;
- the original validated input, inferred from the authoring schema;
- a context that contains limits and any staged upload that F07 supplies.

Call the method with explicitly mapped arguments. Never derive driver option names through a generic case converter. A mapping such as `query.is_completed` → argument 0 property `isCompleted` is recorded in `argumentMap`. Fixtures verify it independently. Invalid input rejects before a driver method is selected or called. The process executor in `src/execution/executor.ts` owns admission, staging, cancellation and result wrapping around these bindings. It uses the F03, F05 and F07 implementations.

Every mapping source must resolve through its complete input path in a schema variant applicable to its call mode. Use `[]` to traverse array items, as in `body.groups[].role_id`. Optional and union fields remain available when declared in an applicable branch. Custom/open JSON paths must follow the explicit extension policy of the schema. Registration rejects misspelled nested fields and controls declared only for a different pagination mode.

Non-paginated tools declare one `single` call. For a page/all pair, use `createListDefinition` from `src/operations/lists.ts`. Declare these items:

- the pagination kind;
- the schema and argument index of each path;
- the options argument index;
- the entity schema;
- the filters.

Each filter declares its schema, exact driver property and serialization once. To check the property name and value type against the public driver, use `satisfies ListFilters<DriverOptions>`. The module derives projection and argument mappings from these declarations. It preserves omitted values and supplied false, zero, empty strings and arrays. Paths must occupy distinct arguments before the options argument. Filters cannot overwrite each other or paging controls.

Spread `list.bind({ page: { binding, call }, all: { binding, call } })` into `defineOperation`. This supplies the input schema, argument map, page response contract and registration-owned bindings. Each callback receives `(method, input, options)`. It explicitly passes its path arguments and the prepared options to the actual overloaded driver method. A response-driven page callback passes only its paths.

See [the project list](../src/operations/families/t01.ts) for a filtered controlled list and [shared-step history](../src/operations/families/t03.ts) for a response-driven list. Retain the canonical endpoint binding in metadata. The parity check compares all three binding identities with the pinned inventory. No additional tools are registered.

## Build strict, representable schemas

Use the utilities in `src/contracts/inputs.ts`. Path IDs, attachment IDs, entry UUIDs, filename/media-type inputs and list controls have reusable schemas. Body fields must follow the domain of the individual endpoint. Use explicit field overrides for valid 0/null sentinels and for stronger constraints that a driver payload schema lacks.

`payloadInput` reuses exported driver schemas and rejects unknown ordinary object fields at every depth. Enable flat `custom_*` JSON extensions or a documented open object explicitly. Nested exceptions require explicit field overrides. Custom values stay flat and preserve their JSON values. Ordinary schemas do not coerce values, insert defaults or convert omission into null. Use `payloadArray` when adapting a driver's bulk array while retaining its size constraints.

The list definition builds page/all alternatives through `createListInput`. Controlled lists accept limit/offset only in page mode and page_size/start_offset only in all mode. Response-driven lists expose neither.

Published schemas retain their registration-time ceilings. The list module supplies effective defaults. It refuses caller bounds above configured maxima before admission or standalone aggregate driver lookup. `_mcp` is adapter input and never forwarded as a TestRail parameter. Keep independently authored expected arguments and wire requests separate from production filter declarations.

Registration uses `createInputContract` in `src/contracts/input-contract.ts` to capture an owned, recursively frozen JSON Schema document and compile its validator once. `inputJsonSchema` audits the authoring schema and produces the SDK-validated document, rejecting unsupported refinements, coercion and default transforms. The two existing driver payload refinements with reviewed structural equivalents are supported explicitly. A new refinement requires an equivalent JSON Schema rule and independent accepted/rejected fixtures through the finalized contract.

Registered operations expose `input.validate(value)` and the same document through `input.jsonSchema` and `jsonSchema`. They do not expose a raw Zod input parser. Successful validation returns the original JSON value without mutation, coercion, defaults, or property removal, including permitted own `__proto__` properties. Direct in-process calls reject non-JSON values such as accessors, proxies, cycles, sparse arrays and non-finite numbers.

Transport validates before admission or staging. Every binding validates before driver lookup. Mutable values are checked on each invocation. Later changes to an authoring schema cannot change an already registered contract. Standalone test bindings can use `driverCall(contract, binding, callback)`. Registration rejects bindings created with a different contract.

Regex constraints must use only the `u` flag so runtime and JSON Schema use the same Unicode matching rules. `multipleOf` constraints are unsupported because the validators disagree on floating-point divisibility, including large values with integer divisors. Metadata may add descriptive annotations. Validation keywords require a tracked, reviewed refinement equivalent. If an exported driver field uses an unsupported constraint, provide an explicit, independently tested field override before registering it.

The authoring audit accepts only represented check kinds, and only on the schema types that emit them. It refuses a length or numeric check that a union, optional or nullable wrapper carries, because the emitter drops that check. The published schema is the runtime validator.

Of the built-in string formats, only `regex` is accepted, because its pattern fully describes a regex. `email` also publishes a `format` that the validator enforces beyond the pattern. `emoji` publishes a `format` that the validator does not know.

URL parsing can normalize input. Custom string predicates, JWT checks and property checks can lose constraints during schema conversion. These require a reviewed adaptation before use. Explicit `__proto__` object-field declarations are also rejected, because the emitter omits them. Permitted open-object and record keys remain supported.

Compilation is strict about unknown keywords and formats. Thus, a published constraint that the validator cannot enforce also fails registration. A permissive emitted document is not evidence that an authoring construct is supported.

## Effects and results

Record TestRail effects separately from local files. Report GETs initiate work and may send email. Their hints are non-read-only/non-idempotent. Their driver policy is `rate-limit-only`. The driver re-sends a rate-limited (429) request, which TestRail rejects before handling, and nothing else. F01 accepted this on 2026-09-17.

Attachment downloads remain ordinary TestRail reads but create distinct persistent local files. Thus, their hints are non-read-only, non-destructive and non-idempotent. The registry validates these exceptions. Other mutations require individually reviewed destructive/idempotent hints. All tools have `openWorldHint: true`. There is no enabled/confirmation/unlock field.

Descriptions append relevant path, pagination, file and report behavior and must remain below 2 KiB in UTF-8. Outer schemas describe usable response structures. Advisory entity schemas are retained separately for F05 to validate each caller without replacing the driver's original data.

## Independent completion evidence

Maintain the [parameter manifests](parameter-manifest.md) separately from registration code. Each family fills every supported parameter, its mapping and valid/invalid domains. Then it runs those literal fixtures through its real driver binding with injected fetch/DNS. A schema-only assertion or a request expectation generated from the registry does not establish parameter coverage.

The registered-parameter test gate requires a complete independent manifest and matching argument targets for every production registration. Whole-body mappings carry reviewed nested fields. Renamed filters require explicit mappings. Adapter-only call selectors have no upstream argument target. An accepted fixture counts toward single/page/all coverage only when its expected driver binding matches the selected call.

A test-only attachment binding demonstrates independent accepted/rejected fixtures passing through the finalized contract and the real driver. It does not implement the F07 persistent-file tool. Comparing the contract with another compilation of its published schema cannot replace those literal expected outcomes.

After you add an entry to `src/operations/catalog.ts`, run `npm run registry:generate`. Then review the generated [operation reference](operation-reference.md).

`npm run registry:check` runs after build in CI. It fails on these items:

- every missing endpoint, which it names with its route, tool and driver method;
- extra tools;
- identity or binding differences;
- stale reference output.

R01 switched `registry:check` to this full-catalog mode after all families were registered. `tests/regression-gates.test.ts` repeats the missing, extra and binding checks inside the test suite. Thus, an endpoint dropped from the catalog fails there even if the reference is regenerated to match. Only `registry:check` compares the reference itself. Pending endpoint and parameter counts must never be presented as completed coverage.
