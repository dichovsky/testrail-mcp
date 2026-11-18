import type { TestRailClient, UploadFilePathInput } from '@dichovsky/testrail-api-client';
import type { Limits } from '../config/limits.js';
import type { InputContract } from '../contracts/input-contract.js';

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
  /** Configured bounds. An aggregate the caller left unbounded runs under these, not the driver's. */
  readonly limits: Limits;
}

export interface DriverCall {
  readonly binding: DriverBinding;
  readonly input: InputContract;
  readonly invoke: (client: TestRailClient, input: unknown, context: CallContext) => Promise<unknown>;
}

/** Registration supplies this builder around its one finalized input contract. */
export type DriverCallBinder<Input extends object> = <const B extends DriverBinding>(
  binding: B,
  call: (method: DriverMethod<B>, input: Input, context: CallContext) => Promise<unknown>,
) => DriverCall & { readonly binding: B };

/**
 * The callback receives the actual overloaded public method type. Parameters<T>
 * would retain only the final overload and lose supported driver call shapes.
 */
export function driverCall<Input extends object, const B extends DriverBinding>(
  contract: InputContract<Input>,
  binding: B,
  call: (method: DriverMethod<B>, input: Input, context: CallContext) => Promise<unknown>,
): DriverCall & { readonly binding: B } {
  return Object.freeze({
    binding,
    input: contract,
    async invoke(client: TestRailClient, input: unknown, context: CallContext): Promise<unknown> {
      // Always validate before selecting or invoking a public driver method.
      // The contract returns the original JSON, including permitted own __proto__ keys.
      const parsed = contract.validate(input);
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
