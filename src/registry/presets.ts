import type { Registry } from '../shared/contracts';

/** Fresh installations start cleanly with no personal hosts or tasks pre-populated. */
export function createDefaultRegistry(): Registry {
  return {
    version: 2,
    revision: 0,
    hosts: [],
    tasks: [],
  };
}
