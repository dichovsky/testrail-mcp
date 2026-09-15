import type { TestRailClient, UploadFilePathInput } from '@dichovsky/testrail-api-client';
import type { z } from 'zod';
import { inputJsonSchema } from '../contracts/inputs.js';

export const driverModules = [
  'projects', 'suites', 'sections', 'cases', 'plans', 'runs', 'tests', 'results',
  'milestones', 'users', 'metadata', 'configurations', 'attachments', 'bdd',
  'sharedSteps', 'variables', 'datasets', 'reports', 'labels',
] as const satisfies readonly (keyof TestRailClient)[];

type DriverModule = typeof driverModules[number];
type AsyncMethod = (...args: never[]) => Promise<unknown>;
type MethodName<M extends DriverModule> = {
  [K in keyof TestRailClient[M]]: TestRailClient[M][K] extends AsyncMethod ? K : never;
}[keyof TestRailClient[M]] & string;

export type DriverBinding = {
  [M in DriverModule]: `${M}.${MethodName<M>}`;
}[DriverModule];

export type DriverMethod<B extends DriverBinding> = B extends `${infer M extends DriverModule}.${infer K}`
  ? K extends keyof TestRailClient[M] ? TestRailClient[M][K] : never
  : never;

/** F07 supplies an owned staged path, never a caller-owned file descriptor. */
export interface CallContext {
  readonly upload?: UploadFilePathInput;
}

export interface DriverCall {
  readonly binding: DriverBinding;
  readonly inputSchema: z.ZodType<object>;
  readonly invoke: (client: TestRailClient, input: unknown, context: CallContext) => Promise<unknown>;
}

/**
 * The callback receives the actual overloaded public method type. Parameters<T>
 * would retain only the final overload and lose supported driver call shapes.
 */
export function driverCall<S extends z.ZodType<object>, const B extends DriverBinding>(
  inputSchema: S,
  binding: B,
  call: (method: DriverMethod<B>, input: z.output<S>, context: CallContext) => Promise<unknown>,
): DriverCall & { readonly binding: B } {
  // Refuse schemas that coerce, default, transform or strip ordinary fields.
  // Once validated, the original JSON is the value promised to the driver.
  inputJsonSchema(inputSchema);
  return Object.freeze({
    binding,
    inputSchema,
    async invoke(client: TestRailClient, input: unknown, context: CallContext): Promise<unknown> {
      // Always validate before selecting or invoking a public driver method.
      inputSchema.parse(input);
      // Zod's otherwise valid JSON/record parsers may omit own __proto__ keys.
      // Never substitute a parsed clone for the caller's validated JSON data.
      const parsed = input as z.output<S>;
      const [moduleName, methodName] = binding.split('.');
      if (!driverModules.some((name) => name === moduleName) || methodName === undefined) {
        throw new Error('Unsupported public driver binding');
      }
      const owner: unknown = Reflect.get(client, moduleName as DriverModule);
      if (typeof owner !== 'object' || owner === null) throw new Error('Missing public driver module');
      const method: unknown = Reflect.get(owner, methodName);
      if (typeof method !== 'function') throw new Error('Missing public driver method');
      // This single type boundary binds the selected method to its own module;
      // callers retain overload checking through DriverMethod<B> above.
      const bound = ((...args: unknown[]): unknown => Reflect.apply(method, owner, args)) as DriverMethod<B>;
      return call(bound, parsed, context);
    },
  });
}
