/**
 * What a host adapter knows about an event that the floor needs to judge wiring routes it cannot see on its own.
 *
 * invariant: every host-specific string arrives here as a value. The floor reads these fields and names no host
 * ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */
export type FloorHostFacts = {
  /** Lower-case, `/`-separated tails that name a protected wiring file in free text. */
  wiringTextNames: readonly string[];
  /** Every string argument, at any depth, of a tool the adapter could not translate; absent for a translated tool. */
  untranslatedToolStrings?: readonly string[];
  /** Base for relative shell operands; absent means the project directory. */
  shellBase?: string;
  /** True when the host's working directory carries an expansion the floor cannot resolve. */
  shellBaseUnresolvable?: boolean;
  /** File names whose mention in a command decides wiring-tamper when the base is unresolvable. */
  wiringFileNames: readonly string[];
  /** Directories that strictly contain a protected target, excluding the project root, the home and a filesystem root. */
  protectedAncestors: readonly string[];
  /** Compare paths with protected targets and ancestors without case. */
  foldCase: boolean;
  /** Alias-free form of an absolute path, used only in the comparison with protected targets and ancestors. Throws when unresolvable. */
  canonical?: (absolutePath: string) => string;
};
