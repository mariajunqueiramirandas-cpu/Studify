// Phase 2 request wrapper: the shared pipeline (_shared/http.ts) with the P2 dependency bundle in ctx.p2.
import { type FnContext, type FnSpec, runFunction } from '../_shared/http.ts';
import type { P2Deps } from './deps.ts';

export type P2Context<I> = FnContext<I> & { p2: P2Deps };

export interface P2Spec<I> extends Omit<FnSpec<I>, 'run'> {
  run(ctx: P2Context<I>): Promise<Response>;
}

/** Builds `(req, deps) => Response` for a Phase 2 function. Same pipeline as every other Edge Function. */
export function defineP2<I>(spec: P2Spec<I>): (req: Request, deps: P2Deps) => Promise<Response> {
  return (req, deps) =>
    runFunction(req, deps, {
      ...spec,
      run: (ctx) => spec.run({ ...ctx, p2: deps }),
    });
}
