# Defining endpoint operations

F04 provides registration, input validation, schema generation and independent parity checks. Endpoint families T01–T12 populate the production catalog; F08 connects it to MCP. The foundation catalog has no endpoint implementations and is not exposed by the development CLI.

## Define one entry per endpoint

Use `defineOperation` with the exact REST token, method, route, family and canonical public driver binding. The tool name is derived as `testrail_<token>`. Include the input schema, explicit argument map, outer response schema, advisory entity schema, paging/file capabilities, TestRail effect and driver retry policy. Required route arguments must exist in every input branch and have mappings in every call mode. Root and query objects must be closed; file and `_mcp` fields are reserved for tools supporting those capabilities. `createRegistry` rejects duplicate literal names at compile time and duplicate dynamic names/routes at runtime, then sorts discovery by tool name.

Use `driverCall(inputSchema, binding, callback)` for each execution mode. Its callback receives the actual bound public method, including overloads, plus parsed input and an optional staged upload supplied by F07. Call the method with explicitly mapped arguments; never derive driver option names through a generic case converter. A mapping such as `query.is_completed` → argument 0 property `isCompleted` is recorded in `argumentMap` and verified independently by fixtures. Invalid input rejects before a driver method is selected or called. This boundary does not perform admission, staging, cancellation or result wrapping; F03, F05 and F07 own those steps around invocation.

Every mapping source must resolve through its complete input path in a schema variant applicable to its call mode. Use `[]` to traverse array items, as in `body.groups[].role_id`. Optional and union fields remain available when declared in an applicable branch; custom/open JSON paths must follow the schema's explicit extension policy. Registration rejects misspelled nested fields and controls declared only for a different pagination mode.

Non-paginated tools declare one `single` call. Paginated tools retain the canonical endpoint binding in metadata and declare separate public `page` and `all` calls. They do not register additional tools. The parity check compares all three binding identities with the pinned inventory.

## Build strict, representable schemas

Use the utilities in `src/contracts/inputs.ts`. Path IDs, attachment IDs, entry UUIDs, filename/media-type inputs and list controls have reusable schemas. Body fields must follow the individual endpoint's domain: use explicit field overrides for valid 0/null sentinels and stronger constraints missing from a driver payload schema.

`payloadInput` reuses exported driver schemas and rejects unknown ordinary object fields at every depth. Opt into flat `custom_*` JSON extensions or a documented open object explicitly. Nested exceptions require explicit field overrides. Custom values stay flat and preserve their JSON values. Ordinary schemas do not coerce values, insert defaults or convert omission into null. Use `payloadArray` when adapting a driver's bulk array while retaining its size constraints.

`createListInput` expresses page/all alternatives structurally. Controlled lists accept limit/offset only in page mode and page_size/start_offset only in all mode. Response-driven lists expose neither. Aggregate limits reflect the configured maxima; runtime adapters supply the effective defaults. `_mcp` is adapter input and never forwarded as a TestRail parameter.

`inputJsonSchema` produces an SDK-validated object schema and rejects unsupported refinements, coercion and default transforms. The two existing driver payload refinements with reviewed structural equivalents are supported explicitly. A new refinement requires an equivalent JSON Schema rule and tests through both Zod and the SDK's independent Ajv validator; do not advertise a wider schema than the runtime accepts.

## Effects and results

Record TestRail effects separately from local files. Report GETs initiate work and may send email; their hints are non-read-only/non-idempotent and their driver policy is `never`. Attachment downloads remain ordinary TestRail reads but create distinct persistent local files, so their hints are non-read-only, non-destructive and non-idempotent. The registry validates these exceptions. Other mutations require individually reviewed destructive/idempotent hints. All tools have `openWorldHint: true`; there is no enabled/confirmation/unlock field.

Descriptions append relevant path, pagination, file and report behavior and must remain below 2 KiB in UTF-8. Outer schemas describe usable response structures; advisory entity schemas are retained separately for F05 to validate each caller without replacing the driver's original data.

## Independent completion evidence

Maintain the [parameter manifests](parameter-manifest.md) separately from registration code. Each family fills every supported parameter, its mapping and valid/invalid domains, then runs those literal fixtures through its real driver binding with injected fetch/DNS. A schema-only assertion or a request expectation generated from the registry does not establish parameter coverage.

The registered-parameter test gate requires a complete independent manifest and matching argument targets for every production registration. Whole-body mappings carry reviewed nested fields; renamed filters require explicit mappings. Adapter-only call selectors have no upstream argument target. An accepted fixture counts toward single/page/all coverage only when its expected driver binding matches the selected call. A test-only attachment binding demonstrates all independent accepted/rejected fixtures passing through both schema validators and the real driver; it does not implement the F07 persistent-file tool.

After adding an entry to `src/operations/catalog.ts`, run `npm run registry:generate` and review the generated [operation reference](operation-reference.md). `npm run registry:check` runs after build in CI: missing family implementations are reported as pending, while extra tools, identity/binding differences and stale reference output fail. `npm run registry:complete` additionally fails on every missing endpoint, naming its route, tool and driver method; R01 enables this full-catalog gate once all families are implemented. Pending endpoint and parameter counts must never be presented as completed coverage.
